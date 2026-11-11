import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { transcribe } from "./transcript.js";

/** One headless Claude Code run: start session `sessionId` (or resume it) with `message`. */
export interface AgentRun {
  sessionId: string;
  resume: boolean;
  message: string;
  /** Left out, Claude Code picks its own. */
  model?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** loopway's MCP endpoint for this session. */
  mcpUrl: string;
  /** Called with each line of the session log as the run goes: assistant text, tool calls, results. */
  onLine: (line: string) => void;
  /** Called once Claude Code has created the session, so later runs must resume it. */
  onStarted: () => void;
  signal?: AbortSignal;
}

export interface RunOutcome {
  /** The process's exit code. */
  code: number;
  /** Whether the run got as far as its `result` record rather than being cut off. */
  finished: boolean;
  /** Set when the run stopped for the usage limit: when it resets, in ms since the epoch. */
  limitedUntil?: number;
  /** Set when the run ended on an API error rather than finishing: the error text. */
  apiError?: string;
}

export type RunAgent = (run: AgentRun) => Promise<RunOutcome>;

/** How long to wait when a run hit the usage limit but didn't say when it resets. */
export const LIMIT_FALLBACK_MS = 5 * 60_000;

/** The one tool of loopway's MCP the session may use without asking. */
export const ALLOWED_TOOLS = ["mcp__loopway__comment"];

/** The arguments of `claude`. The message goes in on stdin. */
export function claudeArgs(run: AgentRun): string[] {
  const mcp = JSON.stringify({ mcpServers: { loopway: { type: "http", url: run.mcpUrl } } });
  const args = ["-p", run.resume ? "--resume" : "--session-id", run.sessionId];
  if (run.model) args.push("--model", run.model);
  // --mcp-config and --allowedTools take several values, so each is followed by another flag.
  args.push("--mcp-config", mcp, "--allowedTools", ...ALLOWED_TOOLS);
  args.push("--permission-mode", "auto", "--output-format", "stream-json", "--verbose");
  return args;
}

/** The fields of Claude Code's stream-json records that say how a run went. */
interface StreamRecord {
  type?: string;
  subtype?: string;
  api_error?: string;
  is_error?: boolean;
  result?: unknown;
  rate_limit_info?: { status?: string; resetsAt?: number };
}

/**
 * What a run's stream-json said about how it ended. Claude Code reports the usage limit twice: a `rate_limit_event`
 * with status `rejected` says when it resets, and the final `result` says the run stopped for it.
 */
class Watch {
  private finished = false;
  private resetsAt?: number;
  private limited = false;
  private error?: string;

  constructor(private readonly onStarted: () => void) {}

  line(raw: string): void {
    let r: StreamRecord;
    try {
      r = JSON.parse(raw) as StreamRecord;
    } catch {
      return;
    }
    if (r.type === "system" && r.subtype === "init") this.onStarted();
    if (r.type === "rate_limit_event" && r.rate_limit_info?.status === "rejected" && r.rate_limit_info.resetsAt) {
      this.resetsAt = r.rate_limit_info.resetsAt * 1000;
    }
    if (r.type === "result") this.result(r);
  }

  private result(r: StreamRecord) {
    this.finished = true;
    if (r.api_error === "usage_limit_reached") this.limited = true;
    // API errors come back with subtype `success`, so the run looks like it finished.
    else if (r.is_error || (typeof r.result === "string" && r.result.startsWith("API Error:"))) {
      this.error = typeof r.result === "string" ? r.result : "the run ended in an error";
    }
  }

  outcome(code: number, now = Date.now()): RunOutcome {
    const resets = this.resetsAt && this.resetsAt > now ? this.resetsAt : now + LIMIT_FALLBACK_MS;
    return {
      code,
      finished: this.finished,
      limitedUntil: this.limited ? resets : undefined,
      apiError: this.limited ? undefined : this.error,
    };
  }
}

/** Runs `claude -p`, headless, and feeds the session log to `run.onLine`. `command` is for tests. */
export const claudeRunner =
  (command = "claude"): RunAgent =>
  async (run) => {
    const child = spawn(command, claudeArgs(run), {
      cwd: run.cwd,
      env: run.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: run.signal,
    });
    const watch = new Watch(run.onStarted);
    const stdout = createInterface({ input: child.stdout }).on("line", (raw) => {
      watch.line(raw);
      for (const line of transcribe(raw)) run.onLine(line);
    });
    // Whatever it says on stderr is worth seeing in the log.
    createInterface({ input: child.stderr }).on("line", (line) => line.trim() && run.onLine(`! ${line}`));
    // A process that exits without reading its stdin closes the pipe: that is its call, not an error here.
    child.stdin.on("error", () => {});
    child.stdin.end(run.message);
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (c) => resolve(c ?? -1));
    });
    stdout.close();
    return watch.outcome(code);
  };
