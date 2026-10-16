import type { RunWatch } from "./agent.js";

/** How long to wait when a run hit the usage limit but didn't say when it resets. */
export const LIMIT_FALLBACK_MS = 5 * 60_000;

/**
 * Watches a run's stream-json. With --replay-user-messages, Claude Code echoes the message we sent
 * once it's in the session. It reports the usage limit twice: a `rate_limit_event` with status
 * `rejected` says when the limit resets, and the final `result` says the run stopped for it.
 */
export class LimitWatch implements RunWatch {
  delivered = false;
  /** Whether the run got as far as its `result` record. */
  finished = false;
  private resetsAt?: number;
  private hit = false;
  private error?: string;

  constructor(private readonly onInit?: () => void) {}

  line(raw: string): void {
    let r: {
      type?: string;
      subtype?: string;
      api_error?: string;
      is_error?: boolean;
      result?: unknown;
      parent_tool_use_id?: string | null;
      message?: { content?: unknown };
      rate_limit_info?: { status?: string; resetsAt?: number };
    };
    try {
      r = JSON.parse(raw) as typeof r;
    } catch {
      return;
    }
    if (r.type === "system" && r.subtype === "init") this.onInit?.();
    // Tool results are user records too, but with content blocks; only our message is a plain string.
    else if (r.type === "user" && !r.parent_tool_use_id && typeof r.message?.content === "string")
      this.delivered = true;
    else if (r.type === "rate_limit_event" && r.rate_limit_info?.status === "rejected" && r.rate_limit_info.resetsAt)
      this.resetsAt = r.rate_limit_info.resetsAt * 1000;
    else if (r.type === "result") {
      this.finished = true;
      if (r.api_error === "usage_limit_reached") this.hit = true;
      // API errors come back with subtype `success`, so the run looks like it finished.
      else if (r.is_error || (typeof r.result === "string" && r.result.startsWith("API Error:")))
        this.error = typeof r.result === "string" ? r.result : "the run ended in an error";
    }
  }

  /** The error the run ended on, if it did and it wasn't the usage limit. */
  apiError(): string | undefined {
    return this.hit ? undefined : this.error;
  }

  /** When the limit resets, if the run stopped because of it. */
  limitedUntil(now = Date.now()): number | undefined {
    if (!this.hit) return undefined;
    return this.resetsAt && this.resetsAt > now ? this.resetsAt : now + LIMIT_FALLBACK_MS;
  }
}
