import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
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
}

export interface RunOutcome {
  /** The process's exit code. */
  code: number;
  /** Set when the run stopped because the account hit its usage limit: when the limit resets, in ms since the epoch. */
  limitedUntil?: number;
}

export type RunAgent = (run: AgentRun) => Promise<RunOutcome>;

/** How long to wait when a run hit the usage limit but didn't say when it resets. */
export const LIMIT_FALLBACK_MS = 5 * 60_000;

/**
 * Watches a run's stream-json for the usage limit. Claude Code reports it twice: a `rate_limit_event`
 * with status `rejected` says when the limit resets, and the final `result` says the run stopped for it.
 */
export class LimitWatch {
  private resetsAt?: number;
  private hit = false;

  line(raw: string): void {
    let r: { type?: string; api_error?: string; rate_limit_info?: { status?: string; resetsAt?: number } };
    try {
      r = JSON.parse(raw) as typeof r;
    } catch {
      return;
    }
    if (r.type === "rate_limit_event" && r.rate_limit_info?.status === "rejected" && r.rate_limit_info.resetsAt)
      this.resetsAt = r.rate_limit_info.resetsAt * 1000;
    else if (r.type === "result" && r.api_error === "usage_limit_reached") this.hit = true;
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
  const log = await open(run.logPath, "a", 0o600);
  try {
    const mcpConfig = JSON.stringify({ mcpServers: { loopway: { type: "http", url: run.mcpUrl } } });
    const args = ["-p", run.resume ? "--resume" : "--session-id", run.sessionId];
    // --mcp-config and --allowedTools take several values, so each is followed by another flag.
    args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__loopway__link", "mcp__loopway__end");
    args.push("--permission-mode", "auto", "--output-format", "stream-json", "--verbose");
    const child = spawn("claude", args, { env: run.env, stdio: ["pipe", "pipe", log.fd] });
    child.stdin!.end(run.message);
    // stdout goes to the log as before, and through the limit watch on the way.
    const watch = new LimitWatch();
    createInterface({ input: child.stdout! }).on("line", (l) => watch.line(l));
    const copied = pipeline(child.stdout!, log.createWriteStream({ autoClose: false }));
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    });
    await copied;
    return { code, limitedUntil: watch.limitedUntil() };
  } finally {
    await log.close();
  }
};

/** packages/cli/prompts/thread.md; the same relative path works from src/ and from the built dist/. */
const PROMPT_FILE = new URL("../../prompts/thread.md", import.meta.url);

/** The instructions every session starts with. */
export async function threadPrompt(): Promise<string> {
  return (await readFile(PROMPT_FILE, "utf8")).trimEnd();
}
