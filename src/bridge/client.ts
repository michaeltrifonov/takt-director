import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { Config } from '../config';
import type { AuthHandle } from '../auth';
import { createClaudeCodeSession, type ClaudeCodeAdapterOptions } from '../adapters/claudeCodeAdapter';
import { loadSessionId, saveSessionId } from '../util/sessionStore';
import type { Message, ReviewDecision, Session, SessionEvent } from '../session/types';
import { DIRECTOR_PROTOCOL } from '../protocol';

/**
 * The outbound agent client.
 *
 * Dials the Takt server's `/agent` namespace, authenticating as the logged-in
 * Takt user (Supabase access token). The server registers this connection and
 * routes that user's `agent_task` dispatches here. This is the reverse of the old
 * inbound bridge: the daemon makes an OUTBOUND connection, so it works behind any
 * NAT/firewall with nothing exposed publicly.
 *
 * Wire protocol (mirrors the server's director-bridge):
 *   server -> daemon  'agent:task'   { taskId, instruction, model?, effort?, workflow? }
 *   daemon -> server  'agent:event'  { taskId, event:SessionEvent }
 *   server -> daemon  'agent:review' { taskId, decision }
 *   server -> daemon  'agent:cancel' { taskId }
 *
 * One Claude Code Session per repo, reused across tasks (it resumes the SDK
 * session, so context carries over). Takt can pick model/effort per task; when
 * they change, the session is recreated WITH resume so context is preserved.
 * Workflows are enabled on the session, and a task with workflow=true opts that
 * turn into a multi-agent workflow via the "ultracode" keyword. The server
 * serializes tasks per user, so the single Session is never driven concurrently.
 */

const ASK_TAKT_PROMPT =
  'You have an MCP tool `ask_takt` (server "takt"). When a decision is a matter of ' +
  'taste, brand, or strategy and multiple options are viable, consult Takt instead of ' +
  "guessing, and treat its answer as the director's call. Don't use it for routine " +
  'mechanical choices.';

// Appended only when Playwright is loaded — tells the agent it can drive a browser
// and that screenshots flow back to the director on their own (no need to narrate them).
const VISUAL_QA_PROMPT =
  '\n\nFor visual QA you have a headless browser via the "playwright" MCP server ' +
  '(browser_navigate, browser_take_screenshot, browser_snapshot, browser_click, browser_type, …). ' +
  'When asked to check how something looks: start the local dev server yourself in the background ' +
  '(e.g. `npm run web` / `npm run dev`), wait for it to come up, navigate to it, interact as needed, ' +
  'and take a screenshot. Screenshots you capture are streamed back to the director automatically — ' +
  'you do NOT need to describe them in words. Prefer a viewport-sized PNG over a full-page capture so ' +
  'the image stays light.';

// Cap one screenshot's base64 size before it crosses the socket. The server raises
// its maxHttpBufferSize to match; a viewport PNG sits comfortably under this.
const MAX_VISUAL_DATAURL_CHARS = 7_000_000; // ~5.2MB decoded

// Validate Takt's per-task knobs before they reach the SDK (the tool schema already
// constrains them, but the daemon never trusts the wire).
const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

interface Profile {
  model?: string;
  effort?: string;
}

const profileKey = (p: Profile): string => `${p.model ?? ''}|${p.effort ?? ''}`;

/** process.env (string|undefined) -> a clean Record<string,string> for subprocess env. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

function adapterOptionsFrom(
  config: Config,
  resumeSessionId: string | undefined,
  profile: Profile,
): ClaudeCodeAdapterOptions {
  return {
    cwd: config.repoPath,
    permissionMode: 'acceptEdits',
    appendSystemPrompt: config.playwrightEnabled ? ASK_TAKT_PROMPT + VISUAL_QA_PROMPT : ASK_TAKT_PROMPT,
    reviewTools: config.reviewTools,
    reviewBashPatterns: config.reviewBashPatterns,
    resumeSessionId,
    // Per-task knobs Takt chose (validated above; cast is safe).
    model: profile.model as ClaudeCodeAdapterOptions['model'],
    effort: profile.effort as ClaudeCodeAdapterOptions['effort'],
    // Always enable Workflows so a task can opt into multi-agent orchestration
    // (triggered per-task by the "ultracode" keyword in the instruction).
    settings: { enableWorkflows: true, workflowKeywordTriggerEnabled: true },
    mcpServers: {
      // The ask_takt consult shim, launched as a stdio subprocess.
      // env REPLACES the subprocess env, so we merge process.env (for PATH etc.).
      takt: {
        type: 'stdio',
        command: config.taktMcpCommand,
        args: config.taktMcpArgs,
        env: {
          ...cleanEnv(process.env),
          TAKT_API_URL: config.taktApiUrl,
          TAKT_CONSULT_PATH: config.taktConsultPath,
          ...(config.taktApiKey ? { TAKT_API_KEY: config.taktApiKey } : {}),
        },
      },
      // Playwright MCP — the browser the agent drives for visual QA. Screenshot
      // image results are pulled out in the adapter and streamed back as visuals.
      ...(config.playwrightEnabled
        ? {
            playwright: {
              type: 'stdio' as const,
              command: config.playwrightCommand,
              args: config.playwrightArgs,
              env: cleanEnv(process.env),
            },
          }
        : {}),
    },
    // Per-task circuit breaker thresholds — the adapter enforces these and
    // interrupts a worker that's stuck thrashing.
    thrash: {
      maxRepeats: config.thrashMaxRepeats,
      maxToolCalls: config.thrashMaxToolCalls,
      maxTokens: config.thrashMaxTokens,
    },
  };
}

export function startAgentClient(config: Config, auth: AuthHandle): void {
  const socket: Socket = io(`${config.taktServerUrl}/agent`, {
    transports: ['websocket'],
    // Re-run on every (re)connect so we always present a fresh access token.
    auth: (cb) => {
      auth
        .getAccessToken()
        .then((token) => cb({ token }))
        .catch(() => cb({ token: '' }));
    },
    reconnection: true,
    reconnectionDelayMax: 10_000,
  });

  // Lazily-created, reused Session. Its event stream is pumped to the server.
  let session: Session | null = null;
  let sessionProfileKey = ''; // the profile the live session was created with
  let currentTaskId = '';
  // The task currently driving the Session. The Session processes ONE task at a
  // time; this lets us interrupt an orphaned turn (server cancel / disconnect /
  // a new task arriving) before starting the next, so two turns never race the
  // shared Claude Code session.
  let activeTaskId: string | null = null;

  // Create (or recreate, on a profile change) the Session for this task's profile.
  // Recreation resumes the persisted SDK session id, so conversation context
  // carries across a model/effort switch.
  function ensureSession(profile: Profile): Session {
    const key = profileKey(profile);
    if (session && key === sessionProfileKey) return session;
    if (session) void session.close(); // old pump ends on close; its finally won't null the new session
    const resume = loadSessionId(config.repoPath);
    const s = createClaudeCodeSession(adapterOptionsFrom(config, resume, profile));
    session = s;
    sessionProfileKey = key;

    // Pump this session's events -> server (tagged with the event's taskId).
    void (async () => {
      try {
        for await (const event of s.events()) {
          if (event.kind === 'session') saveSessionId(config.repoPath, event.sessionId);
          // Drop an oversized screenshot rather than blow the socket's buffer limit.
          if (event.kind === 'visual' && event.visual.dataUrl.length > MAX_VISUAL_DATAURL_CHARS) {
            console.warn(
              `[takt-director] dropping oversized screenshot ` +
                `(${Math.round(event.visual.dataUrl.length / 1024)}KB > ${Math.round(MAX_VISUAL_DATAURL_CHARS / 1024)}KB cap) — ` +
                'capture a viewport PNG instead of a full-page one.',
            );
            continue;
          }
          const taskId = (event as Extract<SessionEvent, { taskId?: string }>).taskId ?? currentTaskId;
          // A turn reached a terminal state — it's no longer the active task.
          if (taskId === activeTaskId && (event.kind === 'error' || (event.kind === 'status' && (event.state === 'completed' || event.state === 'failed')))) {
            activeTaskId = null;
          }
          if (socket.connected) socket.emit('agent:event', { taskId, event });
        }
      } finally {
        // Session loop ended (closed/errored) — drop it so the next task recreates
        // and resumes from the persisted SDK session id.
        if (session === s) {
          session = null;
          sessionProfileKey = '';
        }
        activeTaskId = null;
      }
    })();

    return s;
  }

  socket.on('connect', () => {
    console.log(
      `[takt-director] connected to ${config.taktServerUrl} as ${auth.email ?? 'user'} — ready. ` +
        `repo=${config.repoPath}`,
    );
  });
  socket.on('agent:ready', () => {
    console.log('[takt-director] registered with Takt — waiting for tasks. (edits stage locally; review with git diff)');
  });
  socket.on('disconnect', (reason) => {
    console.log(`[takt-director] disconnected (${reason}) — will reconnect…`);
    // Abort any in-flight turn: the server already gave up on its result, and a
    // turn left running would collide with the next task after reconnect.
    if (session && activeTaskId) {
      void session.interrupt();
      activeTaskId = null;
    }
  });
  socket.on('connect_error', (err: Error) => {
    console.error(`[takt-director] connection error: ${err.message}`);
  });

  // Server dispatches a coding task (with Takt's chosen model/effort/workflow).
  socket.on('agent:task', (payload: { taskId?: string; instruction?: string; model?: string; effort?: string; workflow?: boolean }) => {
    if (!payload?.taskId || !payload.instruction?.trim()) return;

    const profile: Profile = {
      model: typeof payload.model === 'string' && VALID_MODELS.has(payload.model) ? payload.model : undefined,
      effort: typeof payload.effort === 'string' && VALID_EFFORTS.has(payload.effort) ? payload.effort : undefined,
    };

    const reusing = session !== null && profileKey(profile) === sessionProfileKey;
    const s = ensureSession(profile); // recreates (with resume) if the profile changed
    // Defense in depth: when reusing a live session, never drive two turns at once.
    if (reusing && activeTaskId && activeTaskId !== payload.taskId) {
      void s.interrupt();
    }
    activeTaskId = payload.taskId;
    currentTaskId = payload.taskId;

    // workflow=true → opt this turn into a multi-agent workflow via the keyword.
    // DIRECTOR_PROTOCOL is always prepended so the agent runs under the Skeptical
    // Contractor protocol regardless of how the instruction is phrased.
    const taskInstruction = payload.workflow
      ? `${payload.instruction}\n\nTackle this with ultracode — orchestrate it as a multi-agent workflow.`
      : payload.instruction;
    const text = `${DIRECTOR_PROTOCOL}\n\n${taskInstruction}`;

    const message: Message = {
      role: 'user',
      parts: [{ kind: 'text', text }],
      messageId: randomUUID(),
      taskId: payload.taskId,
    };
    void s.send(message);
  });

  // Server aborts a task (e.g. it timed out waiting). Interrupt the turn so it
  // stops running and doesn't collide with the next dispatch.
  socket.on('agent:cancel', (payload: { taskId?: string }) => {
    if (!session || !payload?.taskId || payload.taskId !== activeTaskId) return;
    void session.interrupt();
    activeTaskId = null;
  });

  // Server resolves a review gate (auto-deny in tool mode).
  socket.on('agent:review', (payload: { taskId?: string; decision?: ReviewDecision }) => {
    if (!payload?.decision || !session) return;
    void session.resolveReview(payload.decision);
  });
}
