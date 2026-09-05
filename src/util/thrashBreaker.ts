/**
 * Thrash Breaker — a per-task circuit breaker for the local worker.
 *
 * A worker can get stuck: re-running the same failing command, re-editing the
 * same file with the same content, or grinding tokens without converging. The
 * adapter feeds every tool call and token-usage update through here; when a
 * threshold trips, the adapter interrupts the SDK query and reports the task as
 * failed so the cloud manager (Takt) gets control back instead of paying for an
 * agent spinning in place.
 *
 * All three limits are independent and any can be disabled with 0:
 *   - maxRepeats   : consecutive IDENTICAL tool calls (same tool + input). The
 *                    strongest "stuck in a loop" signal; on by default.
 *   - maxToolCalls : total tool calls in one task. Off by default (legit big
 *                    tasks/workflows make many calls) — opt in for tight loops.
 *   - maxTokens    : cumulative tokens in one task. Off by default; a cost cap.
 */

export interface ThrashConfig {
  maxRepeats: number;
  maxToolCalls: number;
  maxTokens: number;
}

export interface ThrashVerdict {
  tripped: boolean;
  reason?: string;
}

// Cap how much of a tool's input feeds the repeat signature — enough to tell two
// calls apart, bounded so a huge Write payload can't blow up memory. Identical
// large writes still collide (same prefix), which is exactly the thrash we catch.
const SIG_MAX_CHARS = 2000;

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
      }
      return v;
    }) ?? '';
  } catch {
    return String(value);
  }
}

export class ThrashBreaker {
  private toolCalls = 0;
  private tokens = 0;
  private lastSig = '';
  private repeatRun = 0;
  private tripped = false;

  constructor(private readonly cfg: ThrashConfig) {}

  /** Clear all counters — call at the start of each task. */
  reset(): void {
    this.toolCalls = 0;
    this.tokens = 0;
    this.lastSig = '';
    this.repeatRun = 0;
    this.tripped = false;
  }

  /** Record one tool call. Returns the verdict so the caller can act immediately. */
  recordTool(name: string, input: unknown): ThrashVerdict {
    this.toolCalls++;
    const sig = `${name}:${stableStringify(input).slice(0, SIG_MAX_CHARS)}`;
    if (sig === this.lastSig) this.repeatRun++;
    else { this.lastSig = sig; this.repeatRun = 1; }
    return this.check();
  }

  /** Record cumulative token usage for the current task. */
  recordTokens(n: number): ThrashVerdict {
    if (Number.isFinite(n) && n > 0) this.tokens += n;
    return this.check();
  }

  check(): ThrashVerdict {
    if (this.tripped) return { tripped: true };
    if (this.cfg.maxRepeats > 0 && this.repeatRun >= this.cfg.maxRepeats) {
      return this.trip(`repeated the same tool call ${this.repeatRun}× in a row`);
    }
    if (this.cfg.maxToolCalls > 0 && this.toolCalls >= this.cfg.maxToolCalls) {
      return this.trip(`made ${this.toolCalls} tool calls without finishing`);
    }
    if (this.cfg.maxTokens > 0 && this.tokens >= this.cfg.maxTokens) {
      return this.trip(`burned ~${this.tokens.toLocaleString()} tokens on a single task`);
    }
    return { tripped: false };
  }

  private trip(reason: string): ThrashVerdict {
    this.tripped = true;
    return { tripped: true, reason };
  }
}
