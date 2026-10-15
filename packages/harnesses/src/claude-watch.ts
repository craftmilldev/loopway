import type { RunWatch } from "./agent.js";

/** How long to wait when a run hit the usage limit but didn't say when it resets. */
export const LIMIT_FALLBACK_MS = 5 * 60_000;

/** What a failed command or a refused write says when the sandbox (or the write guard) stopped it. */
const DENIAL = /Operation not permitted|Read-only file system|Writes outside the working directory/i;
const MAX_DENIALS = 5;

/** The text of a tool result's content, which is a string or a list of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
}

/** The first line of `text` that matches, trimmed to a length a log can hold. */
const denialLine = (text: string) => (text.split("\n").find((l) => DENIAL.test(l)) ?? text).trim().slice(0, 300);

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
  private readonly denied: string[] = [];

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
    else if (r.type === "user") this.noteDenials(r.message?.content);
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

  /** Keeps the failed tool results that mention a sandbox denial. */
  private noteDenials(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (this.denied.length >= MAX_DENIALS) return;
      if (b?.type !== "tool_result" || !b.is_error) continue;
      const text = resultText(b.content);
      if (DENIAL.test(text)) this.denied.push(denialLine(text));
    }
  }

  denials(): string[] {
    return this.denied;
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
