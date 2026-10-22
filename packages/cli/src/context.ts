import { LoopwayClient } from "./client.js";
import type { AgentRun, RunOutcome } from "@loopway/harnesses";
import { resolveAuth } from "./config.js";
import type { Metrics } from "./metrics.js";

/** Everything a command touches outside its arguments, so tests can swap it out. */
export interface Context {
  /** ~/.loopway by default. */
  configDir: string;
  env: NodeJS.ProcessEnv;
  /** Prompts are only shown when true; otherwise missing input is an error. */
  interactive: boolean;
  /** Writes one chunk of command output to stdout. */
  out: (text: string) => void;
  /** Writes one line to stderr: notes about what a command is doing that shouldn't end up in piped output. */
  err?: (text: string) => void;
  fetch?: typeof fetch;
  /** Runs one `loopway bots run` agent turn; defaults to headless `claude -p`. */
  runAgent?: (run: AgentRun) => Promise<RunOutcome>;
  /** Product metrics; records nothing when unset. */
  metrics?: Metrics;
}

export async function authedClient(ctx: Context): Promise<LoopwayClient> {
  const { api_url, api_key } = await resolveAuth(ctx.configDir, ctx.env);
  return new LoopwayClient({ baseUrl: api_url, apiKey: api_key, fetch: ctx.fetch });
}

/** Thrown when the user backs out of a prompt (Ctrl-C / Esc). */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

/** For bad or missing command input that the API never saw. */
export class UsageError extends Error {}
