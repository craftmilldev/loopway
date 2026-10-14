/** One headless agent run: start session `sessionId` (or resume it) with `message`. */
export interface AgentRun {
  /** The harness to run it with, by name (see harnesses/index.ts). */
  harness: string;
  sessionId: string;
  resume: boolean;
  message: string;
  /** The model to run on, as the harness takes it. */
  model: string;
  logPath: string;
  /** The dispatcher's MCP endpoint for this session (its `link` and `end` tools). */
  mcpUrl: string;
  env: NodeJS.ProcessEnv;
  /** Called once Claude Code has created the session (its `system` `init` record), so later runs must resume it. */
  onStarted?: () => void;
}

export interface RunOutcome {
  /** The process's exit code. */
  code: number;
  /** Whether Claude Code echoed `message` back, which it does once the message is in the session. */
  delivered: boolean;
  /** Whether the run ended with a `result` record rather than being cut off. */
  finished?: boolean;
  /** Set when the run stopped because the account hit its usage limit: when the limit resets, in ms since the epoch. */
  limitedUntil?: number;
  /** Set when the run ended on an API error (offline, asleep, overloaded) rather than finishing: the error text. */
  apiError?: string;
}

/**
 * What every harness reports about a run, from reading its output line by line. A harness that can't tell
 * (say, it has no usage limit) leaves the field at its default.
 */
export interface RunWatch {
  /** Feed it each line the harness writes to stdout. */
  line(raw: string): void;
  /** Whether the harness took the message into its session. */
  delivered: boolean;
  /** Whether the run got as far as its final result rather than being cut off. */
  finished: boolean;
  /** The error the run ended on, if it ended on one that isn't the usage limit. */
  apiError(): string | undefined;
  /** When the usage limit resets (ms since the epoch), if the run stopped because of it. */
  limitedUntil(now?: number): number | undefined;
}

export type RunAgent = (run: AgentRun) => Promise<RunOutcome>;

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
