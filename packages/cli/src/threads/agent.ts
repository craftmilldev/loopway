import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";

/** One headless agent run: start session `sessionId` (or resume it) with `message`. */
export interface AgentRun {
  sessionId: string;
  resume: boolean;
  message: string;
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

export type RunAgent = (run: AgentRun) => Promise<RunOutcome>;

/** How long to wait when a run hit the usage limit but didn't say when it resets. */
export const LIMIT_FALLBACK_MS = 5 * 60_000;

/**
 * Watches a run's stream-json. With --replay-user-messages, Claude Code echoes the message we sent
 * once it's in the session. It reports the usage limit twice: a `rate_limit_event` with status
 * `rejected` says when the limit resets, and the final `result` says the run stopped for it.
 */
export class LimitWatch {
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

/** Runs `claude -p` headless in the current directory, appending its stream-json transcript to the log. */
export const spawnClaude: RunAgent = async (run) => {
  await mkdir(dirname(run.logPath), { recursive: true, mode: 0o700 });
  // Plain descriptors: a FileHandle that is never closed (or closed mid-write) is a fatal error on newer Node.
  const errFd = openSync(run.logPath, "a", 0o600);
  try {
    const mcpConfig = JSON.stringify({ mcpServers: { loopway: { type: "http", url: run.mcpUrl } } });
    const args = ["-p", run.resume ? "--resume" : "--session-id", run.sessionId];
    // --mcp-config and --allowedTools take several values, so each is followed by another flag.
    args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__loopway__link", "mcp__loopway__end");
    args.push("--permission-mode", "auto", "--output-format", "stream-json", "--verbose");
    // The message goes in as stream-json so Claude Code can echo it back once it's in the session.
    args.push("--input-format", "stream-json", "--replay-user-messages");
    const child = spawn("claude", args, { env: run.env, stdio: ["pipe", "pipe", errFd] });
    child.stdin!.end(JSON.stringify({ type: "user", message: { role: "user", content: run.message } }) + "\n");
    // stdout goes to the log as before, and through the watch on the way.
    const watch = new LimitWatch(run.onStarted);
    createInterface({ input: child.stdout! }).on("line", (l) => watch.line(l));
    const copied = pipeline(child.stdout!, createWriteStream(run.logPath, { flags: "a", mode: 0o600 }));
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    });
    // Awaited together, so whichever fails first is the error thrown and neither can go unhandled.
    const [code] = await Promise.all([exited, copied]);
    return {
      code,
      delivered: watch.delivered,
      finished: watch.finished,
      limitedUntil: watch.limitedUntil(),
      apiError: watch.apiError(),
    };
  } finally {
    closeSync(errFd);
  }
};

/** packages/cli/prompts/thread.md; the same relative path works from src/ and from the built dist/. */
const PROMPT_FILE = new URL("../../prompts/thread.md", import.meta.url);

/** The instructions every session starts with. */
export async function threadPrompt(): Promise<string> {
  return (await readFile(PROMPT_FILE, "utf8")).trimEnd();
}
