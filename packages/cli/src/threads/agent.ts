import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** One headless agent run: start session `sessionId` (or resume it) with `message`. Resolves to the exit code. */
export interface AgentRun {
  sessionId: string;
  resume: boolean;
  message: string;
  logPath: string;
  /** The dispatcher's MCP endpoint for this session (its `link` and `end` tools). */
  mcpUrl: string;
  env: NodeJS.ProcessEnv;
}

export type RunAgent = (run: AgentRun) => Promise<number>;

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
    const child = spawn("claude", args, { env: run.env, stdio: ["pipe", log.fd, log.fd] });
    child.stdin!.end(run.message);
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    });
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
