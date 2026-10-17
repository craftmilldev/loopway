import { readFile, writeFile } from "node:fs/promises";
import type { AgentRun, RunWatch } from "./agent.js";
import { Harness, type Launch } from "./harness.js";
import { HARNESS_LABELS } from "./labels.js";

/**
 * Reads the JSONL `codex exec --json` prints. It has no usage-limit signal and doesn't echo the prompt, so a turn
 * that starts counts as delivered; a run either finishes (`turn.completed`), ends on an error, or is cut off.
 */
export class CodexWatch implements RunWatch {
  delivered = false;
  finished = false;
  private error?: string;

  constructor(private readonly onInit?: () => void) {}

  line(raw: string): void {
    let r: { type?: string; message?: unknown; error?: { message?: unknown } };
    try {
      r = JSON.parse(raw) as typeof r;
    } catch {
      return;
    }
    if (r.type === "thread.started") this.onInit?.();
    else if (r.type === "turn.started") this.delivered = true;
    else if (r.type === "turn.completed") {
      this.finished = true;
      // An error event before a completed turn (a dropped MCP connection, say) was got past.
      this.error = undefined;
    } else if (r.type === "turn.failed" || r.type === "error") {
      const message = r.type === "error" ? r.message : r.error?.message;
      this.error = typeof message === "string" && message ? message : "the run ended in an error";
      if (r.type === "turn.failed") this.finished = true;
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
 * OpenAI's Codex CLI, run as `codex exec`. It signs in the way the user's own `codex` does (`codex login`). Codex
 * makes its own thread ids, so the one made for a session is kept beside the session's log (read from the log once
 * the run ends) and later runs resume it.
 */
export class CodexHarness extends Harness {
  readonly name = "codex";
  readonly label = HARNESS_LABELS.codex;
  readonly command = "codex";

  /** The models `codex` lists (its `models_cache.json`) for the accounts it supports. Add new models here and drop retired ones. */
  readonly models = [
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ];

  modelFits(model: string) {
    return this.models.includes(model);
  }

  private threadFile = (run: AgentRun) => `${run.logPath}.thread`;

  async after(run: AgentRun): Promise<void> {
    if ((await readFile(this.threadFile(run), "utf8").catch(() => "")).trim()) return;
    const log = await readFile(run.logPath, "utf8").catch(() => "");
    for (const line of log.split("\n")) {
      if (!line.includes('"thread.started"')) continue;
      try {
        const id = (JSON.parse(line) as { thread_id?: unknown }).thread_id;
        if (typeof id === "string" && id) return await writeFile(this.threadFile(run), id + "\n", { mode: 0o600 });
      } catch {
        // Not a record; look at the next line.
      }
    }
  }

  async launch(run: AgentRun): Promise<Launch> {
    // A resumed session whose thread id is gone (the log directory was cleaned) starts a new thread; the message
    // still goes in, but without the old conversation.
    const thread = run.resume ? (await readFile(this.threadFile(run), "utf8").catch(() => "")).trim() : "";
    const args = ["exec", ...(thread ? ["resume"] : []), "--json", "--skip-git-repo-check", "-m", run.model];
    // A new thread takes its working root as a flag. `exec resume` doesn't accept -C; the spawn's cwd covers it.
    if (run.cwd && !thread) args.push("-C", run.cwd);
    // The dispatcher's tools, with their calls approved up front: a headless run has nobody to ask.
    args.push("-c", `mcp_servers.loopway.url=${JSON.stringify(run.mcpUrl)}`);
    args.push("-c", 'mcp_servers.loopway.default_tools_approval_mode="approve"');
    // No sandbox, as with Claude: the bot runs with your access, and a headless run has nobody to approve commands.
    args.push("--dangerously-bypass-approvals-and-sandbox");
    // The message goes in on stdin, so one that starts with a dash isn't read as a flag.
    args.push(...(thread ? [thread] : []), "-");
    return { args, stdin: run.message };
  }

  watch(onStarted?: () => void) {
    return new CodexWatch(onStarted);
  }
}
