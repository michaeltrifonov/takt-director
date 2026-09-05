/**
 * The Session seam.
 *
 * This is the ONE abstraction the director (Takt) talks to. It is deliberately
 * shaped after A2A's verbs (message/send, streamed events + artifacts, an
 * INPUT_REQUIRED review gate, an Agent-Card handshake) so that:
 *   (a) the abstraction is clean regardless of what's underneath, and
 *   (b) if we ever expose Takt's own side as an A2A server, the verbs already match.
 *
 * It is NOT an A2A wire implementation. Claude Code does not speak A2A (verified
 * Jun 2026: no native A2A server/client; Anthropic is MCP-only). The only real
 * driver is the Claude Agent SDK, which `adapters/claudeCodeAdapter.ts` implements
 * behind this interface. The seam is insurance, not a dependency.
 */

export type Role = 'user' | 'agent';

export interface Part {
  kind: 'text' | 'file' | 'data';
  text?: string;
  /** for file/data parts (screenshots, build output, diffs); shape TBD */
  data?: unknown;
  mimeType?: string;
}

export interface Message {
  role: Role;
  parts: Part[];
  messageId: string;
  taskId?: string;
  contextId?: string;
}

/** A2A-aligned task lifecycle (subset). `input-required` is the human review gate. */
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

/** A produced result: a file edit, a build log, a screenshot, etc. */
export interface Artifact {
  artifactId: string;
  name?: string;
  parts: Part[];
}

/**
 * A captured visual (browser screenshot / rendered DOM image) streamed back to
 * the director for the "taste" check. The image rides as a base64 data URL so it
 * needs no out-of-band fetch; the server uploads it to storage and folds it into
 * the manager turn's context. Keep these reasonably sized (viewport PNG/JPEG) —
 * the bridge guards against oversized payloads.
 */
export interface VisualPayload {
  /** base64 data URL: `data:image/<png|jpeg>;base64,...` */
  dataUrl: string;
  mimeType: string;
  /** provenance for the manager's context (tool name, page URL, a short caption) */
  source?: string;
  label?: string;
}

/** Payload of a pending review gate (mapped from the SDK's canUseTool callback). */
export interface ReviewRequest {
  reviewId: string;
  toolName: string;
  input: unknown;
  /** human-readable: "Takt wants to run `git push origin main`" */
  summary: string;
}

/** The director's answer to a review gate. */
export interface ReviewDecision {
  reviewId: string;
  approved: boolean;
  reason?: string;
  /** optionally rewrite the tool input before allowing */
  updatedInput?: Record<string, unknown>;
}

/** Events streamed from the agent back to the director. */
export type SessionEvent =
  | { kind: 'status'; taskId: string; state: TaskState; message?: Message }
  | { kind: 'message'; taskId: string; message: Message }
  | { kind: 'artifact'; taskId: string; artifact: Artifact }
  // A captured screenshot / DOM render streamed back for visual QA. The server
  // turns it into an image attachment the manager (and the human) can see.
  | { kind: 'visual'; taskId: string; visual: VisualPayload }
  // A short, human-readable progress label ("editing config.ts", "running tests")
  // streamed live as the agent works — surfaced to the user as Takt's activity line.
  | { kind: 'activity'; taskId: string; label: string }
  | { kind: 'review-request'; taskId: string; review: ReviewRequest }
  | { kind: 'session'; taskId?: string; sessionId: string }
  | { kind: 'error'; taskId: string; error: string };

/**
 * The seam itself. One Session == one live Claude Code agent loop.
 * `events()` has a single consumer (the bridge connection).
 */
export interface Session {
  readonly id: string;

  /** Director -> agent. Injects a user message into the running session. Returns the taskId. */
  send(message: Message): Promise<{ taskId: string }>;

  /** Agent -> director. Stream of status / messages / artifacts / review requests. */
  events(): AsyncIterable<SessionEvent>;

  /** Resolve a pending review gate (approve/deny). */
  resolveReview(decision: ReviewDecision): Promise<void>;

  /** Interrupt the current task. */
  interrupt(): Promise<void>;

  /** Tear down the session. */
  close(): Promise<void>;
}
