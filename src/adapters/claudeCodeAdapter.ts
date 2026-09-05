import { randomUUID } from 'node:crypto';
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue, deferred } from '../util/asyncQueue';
import { ThrashBreaker, type ThrashConfig } from '../util/thrashBreaker';
import type { Artifact, Message, ReviewDecision, Session, SessionEvent, VisualPayload } from '../session/types';
import { buildAgentCard } from '../session/card';

/**
 * Claude Code adapter — implements the Session seam by driving the Claude Agent SDK
 * (@anthropic-ai/claude-agent-sdk, verified against 0.3.x). The ONLY file that
 * touches the SDK; everything above speaks the A2A-shaped Session interface.
 */

// Built-in tools whose tool_use is a concrete file change worth surfacing as an artifact.
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface ClaudeCodeAdapterOptions {
  /** the local repo Claude Code works in */
  cwd: string;
  /** appended to Claude Code's default system prompt (preset+append) */
  appendSystemPrompt?: string;
  allowedTools?: string[];
  /** 'acceptEdits' = auto-stage file edits (you review the diff yourself); Bash still gated. */
  permissionMode?: PermissionMode;
  /** MCP servers loaded into the session (e.g. the ask_takt consult shim). */
  mcpServers?: Options['mcpServers'];
  /** resume a prior SDK session id (picks up code-state context) */
  resumeSessionId?: string;
  /** called when the SDK session id is first learned (for persistence) */
  onSessionId?: (sessionId: string) => void;

  // ── review gate policy ──
  reviewTools?: string[];
  reviewBashPatterns?: string[];

  // ── per-task SDK knobs (Takt picks these per dispatch) ──
  /** model for this session ('opus' | 'sonnet' | 'haiku' or a full id) */
  model?: Options['model'];
  /** thinking effort ('low' | 'medium' | 'high' | 'xhigh' | 'max') */
  effort?: Options['effort'];
  /** inline settings (e.g. { enableWorkflows, workflowKeywordTriggerEnabled }) */
  settings?: Options['settings'];

  /** per-task circuit-breaker thresholds (thrash detection); omitted → disabled. */
  thrash?: ThrashConfig;
}

export function createClaudeCodeSession(opts: ClaudeCodeAdapterOptions): Session {
  const id = randomUUID();
  const inbound = new AsyncQueue<SDKUserMessage>();
  const outbound = new AsyncQueue<SessionEvent>();
  const pendingReviews = new Map<string, (d: ReviewDecision) => void>();

  let currentTaskId: string = randomUUID();
  let lastEmittedText = '';
  let sdkSessionId: string | undefined = opts.resumeSessionId;
  let queryHandle: Query | undefined;

  const reviewTools = new Set(opts.reviewTools ?? []);
  const reviewBashPatterns = opts.reviewBashPatterns ?? [];

  const breaker = new ThrashBreaker(opts.thrash ?? { maxRepeats: 0, maxToolCalls: 0, maxTokens: 0 });
  // The task we already reported as thrash-failed — drop its remaining messages
  // (the SDK keeps yielding briefly after interrupt) and don't double-report.
  let trippedTaskId: string | null = null;

  const emit = (event: SessionEvent) => outbound.push(event);

  const agentMessage = (text: string): Message => ({
    role: 'agent',
    parts: [{ kind: 'text', text }],
    messageId: randomUUID(),
    taskId: currentTaskId,
  });

  // Emit assistant text once. The final `result` message repeats the last
  // assistant text, so dedupe against the last thing we emitted.
  function emitAgentText(text: string): void {
    const t = text.trim();
    if (!t || t === lastEmittedText) return;
    lastEmittedText = t;
    emit({ kind: 'message', taskId: currentTaskId, message: agentMessage(t) });
  }

  function captureSession(sessionId: string | undefined): void {
    if (!sessionId || sessionId === sdkSessionId) return;
    sdkSessionId = sessionId;
    emit({ kind: 'session', taskId: currentTaskId, sessionId });
    opts.onSessionId?.(sessionId);
  }

  // Thrash breaker tripped: report the task failed (so the manager regains control)
  // and interrupt the SDK so the worker stops burning tokens in place.
  function tripThrash(reason: string): void {
    if (trippedTaskId === currentTaskId) return;
    trippedTaskId = currentTaskId;
    emit({ kind: 'message', taskId: currentTaskId, message: agentMessage(`⚠️ Stopped by the thrash breaker: ${reason}.`) });
    emit({ kind: 'status', taskId: currentTaskId, state: 'failed' });
    void queryHandle?.interrupt();
  }

  // Pull token usage off an SDK message (assistant turns and the final result carry
  // it) and feed the breaker's cumulative-token guard.
  function recordUsageFrom(msg: SDKMessage): void {
    const usage =
      (msg as { message?: { usage?: Record<string, number> } }).message?.usage ??
      (msg as { usage?: Record<string, number> }).usage;
    if (!usage) return;
    const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    const verdict = breaker.recordTokens(total);
    if (verdict.tripped && verdict.reason) tripThrash(verdict.reason);
  }

  function needsReview(toolName: string, input: Record<string, unknown>): boolean {
    if (reviewTools.has(toolName)) return true;
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const cmd = input.command.toLowerCase();
      return reviewBashPatterns.some((p) => p && cmd.includes(p.toLowerCase()));
    }
    return false;
  }

  // Maps the SDK permission callback onto an A2A-style INPUT_REQUIRED review gate.
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (!needsReview(toolName, input)) {
      return { behavior: 'allow', updatedInput: input };
    }
    const reviewId = randomUUID();
    const review = deferred<ReviewDecision>();
    pendingReviews.set(reviewId, review.resolve);

    emit({ kind: 'status', taskId: currentTaskId, state: 'input-required' });
    emit({
      kind: 'review-request',
      taskId: currentTaskId,
      review: { reviewId, toolName, input, summary: summarizeTool(toolName, input) },
    });

    const decision = await review.promise;
    pendingReviews.delete(reviewId);
    emit({ kind: 'status', taskId: currentTaskId, state: 'working' });

    if (decision.approved) {
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
    }
    return { behavior: 'deny', message: decision.reason ?? 'Rejected by reviewer.' };
  };

  function handleAssistantContent(content: unknown): void {
    if (typeof content === 'string') {
      emitAgentText(content);
      return;
    }
    if (!Array.isArray(content)) return;

    const texts: string[] = [];
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> };
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      } else if (block.type === 'tool_use' && block.name) {
        // Feed the thrash breaker first — every tool call counts, even gated ones.
        const verdict = breaker.recordTool(block.name, block.input ?? {});
        if (verdict.tripped && verdict.reason) {
          tripThrash(verdict.reason);
          return;
        }
        // Each tool call streams a short progress label (the user's "what's going on"
        // activity line); file edits additionally surface as an artifact. Skipped for
        // review-gated tools — in tool mode those are auto-denied, so surfacing
        // "running git push" for a command that never executes would mislead.
        if (!needsReview(block.name, block.input ?? {})) {
          emit({ kind: 'activity', taskId: currentTaskId, label: activityLabel(block.name, block.input ?? {}) });
          if (EDIT_TOOLS.has(block.name)) {
            emit({ kind: 'artifact', taskId: currentTaskId, artifact: fileArtifact(block) });
          }
        }
      }
      // Screenshots/DOM renders come back as tool_result IMAGE content on the
      // following `user` SDK message, not here — see handleToolResultContent().
    }
    const joined = texts.join('\n').trim();
    emitAgentText(joined);
  }

  // Tool results stream back as `user` SDK messages whose content array holds
  // tool_result blocks. A browser-screenshot tool (Playwright MCP) returns image
  // content inside those — pull each out as a `visual` event for the director.
  function handleToolResultContent(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as { type?: string; content?: unknown };
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      for (const inner of block.content) {
        const visual = visualFromImageBlock(inner);
        if (visual) emit({ kind: 'visual', taskId: currentTaskId, visual });
      }
    }
  }

  function translate(msg: SDKMessage): void {
    captureSession((msg as { session_id?: string }).session_id);

    // Already reported this task as thrash-failed — ignore the SDK's trailing
    // messages until the next task (send() resets the breaker and the task id).
    if (trippedTaskId === currentTaskId) return;

    // On session init, log which auth the spawned agent is actually using so you
    // can confirm subscription vs API-key billing. 'oauth' = your subscription.
    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
      const src = (msg as { apiKeySource?: string }).apiKeySource;
      if (src) {
        const onApiKey = src === 'user' || src === 'project' || src === 'org' || src === 'temporary';
        const label = onApiKey ? ' (API key / pay-as-you-go)' : ' (no API key → your subscription login)';
        console.log(`[takt-director] agent auth: apiKeySource=${src}${label}`);
      }
    }

    switch (msg.type) {
      case 'assistant': {
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        handleAssistantContent(content);
        recordUsageFrom(msg);
        // handleAssistantContent / recordUsageFrom may have tripped the breaker —
        // don't announce "working" on a task we just failed.
        if (trippedTaskId !== currentTaskId) {
          emit({ kind: 'status', taskId: currentTaskId, state: 'working' });
        }
        break;
      }
      case 'user': {
        // Tool results (incl. browser screenshots) come back as `user` messages.
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        handleToolResultContent(content);
        break;
      }
      case 'result': {
        const m = msg as { subtype?: string; result?: unknown };
        if (m.subtype === 'success' && typeof m.result === 'string') {
          emitAgentText(m.result);
          emit({ kind: 'status', taskId: currentTaskId, state: 'completed' });
        } else {
          emit({ kind: 'error', taskId: currentTaskId, error: `result: ${m.subtype ?? 'error'}` });
          emit({ kind: 'status', taskId: currentTaskId, state: 'failed' });
        }
        break;
      }
      default:
        // system/init, partials, tool-progress, etc. — session id already captured above.
        break;
    }
  }

  // Start the agent loop once; it consumes `inbound` as streaming input for the
  // session's lifetime (one 'result' per director turn, loop ends when inbound closes).
  void (async () => {
    try {
      const options: Options = {
        cwd: opts.cwd,
        permissionMode: opts.permissionMode ?? 'acceptEdits',
        canUseTool,
      };
      if (opts.model) options.model = opts.model;
      if (opts.effort) options.effort = opts.effort;
      if (opts.settings) options.settings = opts.settings;
      if (opts.appendSystemPrompt) {
        options.systemPrompt = { type: 'preset', preset: 'claude_code', append: opts.appendSystemPrompt };
      }
      if (opts.allowedTools) options.allowedTools = opts.allowedTools;
      if (opts.mcpServers) options.mcpServers = opts.mcpServers;
      if (sdkSessionId) options.resume = sdkSessionId;

      const q = query({ prompt: inbound as AsyncIterable<SDKUserMessage>, options });
      queryHandle = q;

      for await (const msg of q) {
        translate(msg);
      }
    } catch (err) {
      emit({ kind: 'error', taskId: currentTaskId, error: errText(err) });
      emit({ kind: 'status', taskId: currentTaskId, state: 'failed' });
    } finally {
      outbound.close();
    }
  })();

  return {
    id,
    card: () => buildAgentCard(),
    async send(message: Message) {
      if (message.taskId) currentTaskId = message.taskId;
      // Dedup is per-turn: each director turn (e.g. a new agent_task round) may
      // legitimately repeat text the previous turn ended with ("Done.", a summary).
      // Reset so an identical reply isn't swallowed as a duplicate.
      lastEmittedText = '';
      // Fresh task — clear the thrash counters so a new dispatch starts clean.
      breaker.reset();
      inbound.push({
        type: 'user',
        message: { role: 'user', content: messageToText(message) },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      emit({ kind: 'status', taskId: currentTaskId, state: 'working' });
      return { taskId: currentTaskId };
    },
    events() {
      return outbound;
    },
    async resolveReview(decision: ReviewDecision) {
      pendingReviews.get(decision.reviewId)?.(decision);
    },
    async interrupt() {
      await queryHandle?.interrupt();
    },
    async close() {
      inbound.close();
      for (const [reviewId, resolve] of pendingReviews) {
        resolve({ reviewId, approved: false, reason: 'session closed' });
      }
      pendingReviews.clear();
    },
  };
}

// ── helpers ──

function fileArtifact(block: { name?: string; id?: string; input?: Record<string, unknown> }): Artifact {
  const input = block.input ?? {};
  const file = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  return {
    artifactId: block.id ?? randomUUID(),
    name: file ?? block.name,
    parts: [
      {
        kind: 'file',
        text: `${block.name ?? 'edit'} → ${file ?? '(unknown path)'}`,
        data: { tool: block.name, file },
      },
    ],
  };
}

function messageToText(message: Message): string {
  return message.parts
    .filter((p) => p.kind === 'text' && p.text)
    .map((p) => p.text as string)
    .join('\n');
}

// A short, friendly progress label for a tool call — what the user sees streamed
// on Takt's activity line ("editing config.ts", "running tests", "searching the code").
// Kept generic so it reads well for coding AND tool/MCP/data-retrieval work.
function activityLabel(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown): string => {
    if (typeof p !== 'string') return '';
    const parts = p.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? '';
  };
  switch (toolName) {
    case 'Read': {
      const f = base(input.file_path ?? input.notebook_path);
      return f ? `reading ${f}` : 'reading a file';
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const f = base(input.file_path ?? input.notebook_path ?? input.path);
      return f ? `editing ${f}` : 'editing files';
    }
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command.trim().split(/\s+/).slice(0, 3).join(' ') : '';
      return cmd ? `running ${cmd}` : 'running a command';
    }
    case 'Grep':
      return 'searching the code';
    case 'Glob':
      return 'scanning files';
    case 'WebFetch':
    case 'WebSearch':
      return 'looking something up';
    case 'Task':
      return 'spinning up a sub-agent';
    case 'TodoWrite':
      return 'planning the work';
    default: {
      // MCP tools arrive as `mcp__<server>__<tool>`. ask_takt is Takt consulting
      // itself — not worth surfacing. Other MCP tools → "using <tool>".
      if (toolName.startsWith('mcp__')) {
        const tool = toolName.split('__').pop() ?? toolName;
        if (tool === 'ask_takt') return 'thinking it over';
        const browser = browserActivityLabel(tool);
        if (browser) return browser;
        return `using ${tool}`;
      }
      return `running ${toolName}`;
    }
  }
}

// Pull a screenshot out of one tool_result content item. Handles the Anthropic
// image block shape ({ type:'image', source:{ type:'base64', media_type, data } })
// the Agent SDK normalizes MCP image results into, plus a defensive raw-MCP shape.
// Returns null for any non-image content.
function visualFromImageBlock(inner: unknown): VisualPayload | null {
  if (!inner || typeof inner !== 'object') return null;
  const b = inner as {
    type?: string;
    source?: { type?: string; media_type?: string; data?: string };
    data?: string;
    mimeType?: string;
  };
  if (b.type !== 'image') return null;
  // Standard Anthropic base64 image source.
  if (b.source?.type === 'base64' && b.source.data) {
    const mimeType = b.source.media_type ?? 'image/png';
    return { dataUrl: `data:${mimeType};base64,${b.source.data}`, mimeType, source: 'screenshot' };
  }
  // Defensive: a raw MCP-style { type:'image', data, mimeType } passthrough.
  if (typeof b.data === 'string' && b.data) {
    const mimeType = b.mimeType ?? 'image/png';
    const dataUrl = b.data.startsWith('data:') ? b.data : `data:${mimeType};base64,${b.data}`;
    return { dataUrl, mimeType, source: 'screenshot' };
  }
  return null;
}

// Friendly activity-line labels for Playwright MCP browser tools
// (mcp__playwright__browser_*). Returns null for non-browser tools.
function browserActivityLabel(tool: string): string | null {
  if (!tool.startsWith('browser_')) return null;
  const map: Record<string, string> = {
    browser_navigate: 'opening the page',
    browser_navigate_back: 'going back',
    browser_take_screenshot: 'taking a screenshot',
    browser_snapshot: 'capturing the page',
    browser_click: 'clicking around',
    browser_type: 'typing into the page',
    browser_fill_form: 'filling the form',
    browser_hover: 'hovering an element',
    browser_select_option: 'picking an option',
    browser_press_key: 'pressing a key',
    browser_wait_for: 'waiting for the page',
    browser_resize: 'resizing the viewport',
    browser_console_messages: 'reading the console',
    browser_network_requests: 'checking network',
  };
  return map[tool] ?? `browser: ${tool.replace(/^browser_/, '').replace(/_/g, ' ')}`;
}

function summarizeTool(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') return `run: ${input.command}`;
  const blob = JSON.stringify(input);
  return `${toolName}: ${blob.length > 160 ? blob.slice(0, 157) + '…' : blob}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
