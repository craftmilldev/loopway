import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentRun, RunWatch } from "../agent.js";
import { Harness, type Launch } from "../harness.js";

const exec = promisify(execFile);

/**
 * Reads the stream-json `cursor-agent` prints. It has no usage-limit signal, so a run either finishes (a `result`
 * record), ends on an error `result`, or is cut off.
 */
export class CursorWatch implements RunWatch {
  delivered = false;
  finished = false;
  private error?: string;

  constructor(private readonly onInit?: () => void) {}

  line(raw: string): void {
    let r: { type?: string; subtype?: string; is_error?: boolean; result?: unknown };
    try {
      r = JSON.parse(raw) as typeof r;
    } catch {
      return;
    }
    if (r.type === "system" && r.subtype === "init") this.onInit?.();
    // The prompt is echoed back as a `user` record once it's in the chat.
    else if (r.type === "user") this.delivered = true;
    else if (r.type === "result") {
      this.finished = true;
      if (r.is_error) this.error = typeof r.result === "string" && r.result ? r.result : "the run ended in an error";
    }
  }

  apiError(): string | undefined {
    return this.error;
  }

  limitedUntil(): undefined {
    return undefined;
  }
}

/**
 * Cursor's CLI, run as `cursor-agent -p`. It reads MCP servers from `.cursor/mcp.json` in its workspace, and each
 * session has its own MCP endpoint, so every run gets a workspace of its own holding that file (removed after);
 * the directory the dispatcher runs in is added to it. Cursor makes its own chat ids, so the one made for a session
 * is kept beside the session's log.
 */
export class CursorHarness extends Harness {
  readonly name = "cursor";
  readonly command = "cursor-agent";

  private workspace = (run: AgentRun) => `${run.logPath}.workspace`;
  private chatFile = (run: AgentRun) => `${run.logPath}.chat`;

  async before(run: AgentRun): Promise<void> {
    const workspace = this.workspace(run);
    await mkdir(`${workspace}/.cursor`, { recursive: true, mode: 0o700 });
    await writeFile(`${workspace}/.cursor/mcp.json`, JSON.stringify({ mcpServers: { loopway: { url: run.mcpUrl } } }), {
      mode: 0o600,
    });
    // A resumed session whose chat id is gone (the log directory was cleaned, or another runner made it) starts a
    // new chat; the message still goes in, but without the old conversation.
    if (run.resume && (await readFile(this.chatFile(run), "utf8").catch(() => ""))) return;
    const { stdout } = await exec(this.command, ["create-chat"], { cwd: workspace, env: run.env });
    const chat = stdout.trim().split("\n").pop()!.trim();
    if (!chat) throw new Error("cursor-agent create-chat printed no chat id");
    await writeFile(this.chatFile(run), chat + "\n", { mode: 0o600 });
  }

  async after(run: AgentRun): Promise<void> {
    await rm(this.workspace(run), { recursive: true, force: true });
  }

  async launch(run: AgentRun): Promise<Launch> {
    const chat = (await readFile(this.chatFile(run), "utf8")).trim();
    const args = ["-p", "--resume", chat, "--model", run.model, "--output-format", "stream-json"];
    args.push("--force", "--trust", "--approve-mcps");
    args.push("--workspace", this.workspace(run), "--add-dir", process.cwd(), run.message);
    return { args };
  }

  watch(onStarted?: () => void) {
    return new CursorWatch(onStarted);
  }
}
