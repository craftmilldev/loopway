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
  /** false runs the agent without its sandbox (`--no-sandbox`). Sandboxed unless this is false. */
  sandbox?: boolean;
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
