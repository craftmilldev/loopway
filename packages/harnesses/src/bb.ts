import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentRun, RunOutcome, RunWatch } from "./agent.js";
import { Harness, type Launch } from "./harness.js";

/** How long a single turn may run before the runner gives up on it. */
const TURN_TIMEOUT = "12h";

/** Runs `bb` and returns stdout. Rejects with bb's own error (its `--json` errors go to stdout) when it fails. */
function bb(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile("bb", args, { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolvePromise(stdout);
      const detail = (() => {
        try {
          return (JSON.parse(stdout) as { error?: { message?: string } }).error?.message;
        } catch {
          return undefined;
        }
      })();
      reject(new Error(`bb ${args.slice(0, 2).join(" ")} failed: ${detail ?? (stderr.trim() || err.message)}`));
    });
    // bb may exit before reading its stdin; the callback above says why, so the EPIPE is not a second error.
    child.stdin!.on("error", () => {});
    child.stdin!.end(stdin ?? "");
  });
}

/** bb is not a stream: a run is a thread we send a message to and wait on, so the harness fills in the watch itself. */
class BbWatch implements RunWatch {
  delivered = false;
  finished = false;
  error?: string;
  line(): void {}
  apiError() {
    return this.error;
  }
  limitedUntil(): undefined {
    return undefined;
  }
}

/**
 * bb (getbb.app) as another runner: loopway pushes each message into a bb thread and waits for the turn to end. The
 * thread's agent is whatever bb runs for the project (`provider/model` picks one; a bare model uses the project's
 * provider). The project comes from `LOOPWAY_BB_PROJECT`, else the bb project whose path holds the directory the
 * dispatcher runs in. Each run gets a workspace of its own holding a `.mcp.json` with the session's MCP endpoint,
 * removed after, and the thread runs there; the dispatcher's directory is named in the message. The thread's id is
 * kept beside the session's log so a resumed session sends to the same thread.
 */
export class BbHarness extends Harness {
  readonly name = "bb";
  readonly command = "bb";

  /** bb's models depend on its providers and account, so any name goes through and bb has the last word. */
  modelFits(model: string) {
    return model.trim().length > 0;
  }

  private workspace = (run: AgentRun) => `${run.logPath}.workspace`;
  private threadFile = (run: AgentRun) => `${run.logPath}.thread`;

  private async project(run: AgentRun): Promise<string> {
    if (run.env.LOOPWAY_BB_PROJECT) return run.env.LOOPWAY_BB_PROJECT;
    const projects = JSON.parse(await bb(["project", "list", "--json"], run.env)) as { id: string; path: string }[];
    const here = process.cwd();
    const inside = (p: string) => {
      const rel = relative(resolve(p), here);
      return !rel.startsWith("..") && !isAbsolute(rel);
    };
    const match = projects.filter((p) => p.path && inside(p.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!match)
      throw new Error(`no bb project holds ${here}; set LOOPWAY_BB_PROJECT to a project id (bb project list)`);
    return match.id;
  }

  /** Unused: `run` talks to bb's threads itself rather than spawning one process. */
  launch(): Launch {
    return { args: [] };
  }

  watch() {
    return new BbWatch();
  }

  async run(run: AgentRun): Promise<RunOutcome> {
    await mkdir(dirname(run.logPath), { recursive: true, mode: 0o700 });
    const log = (text: string) => appendFile(run.logPath, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
    const watch = new BbWatch();
    const workspace = this.workspace(run);
    try {
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await writeFile(
        `${workspace}/.mcp.json`,
        JSON.stringify({ mcpServers: { loopway: { type: "http", url: run.mcpUrl } } }),
        { mode: 0o600 },
      );
      const message = `The dispatcher's directory is ${process.cwd()}; work there.\n\n${run.message}`;
      let thread = run.resume ? (await readFile(this.threadFile(run), "utf8").catch(() => "")).trim() : "";
      if (thread) {
        await bb(["thread", "tell", thread, "--mode", "auto", "--message-file", "-", "--json"], run.env, message);
      } else {
        // A resumed session whose thread id is gone starts a new thread; the message still goes in.
        const args = ["thread", "spawn", "--json", "--project", await this.project(run), "--environment", workspace];
        args.push("--model", run.model, "--prompt-file", "-");
        const created = JSON.parse(await bb(args, run.env, message)) as { id: string };
        thread = created.id;
        await writeFile(this.threadFile(run), thread + "\n", { mode: 0o600 });
      }
      watch.delivered = true;
      run.onStarted?.();
      await log(`bb thread ${thread}: message sent`);
      // The turn may not have begun yet, and `idle` would match straight away; give it a moment to show as running.
      await bb(["thread", "wait", thread, "--status", "running", "--timeout", "30s", "--json"], run.env).catch(
        () => {},
      );
      await bb(["thread", "wait", thread, "--status", "idle", "--timeout", TURN_TIMEOUT, "--json"], run.env);
      const shown = JSON.parse(await bb(["thread", "show", thread, "--json"], run.env)) as {
        thread: { status: string };
      };
      const output = JSON.parse(await bb(["thread", "output", thread, "--json"], run.env).catch(() => "{}")) as {
        output?: string;
      };
      if (output.output) await log(output.output);
      // A thread that ends its turn in an error says so in its status.
      if (/error|fail/i.test(shown.thread.status))
        throw new Error(`bb thread ${thread} ended as ${shown.thread.status}`);
      watch.finished = true;
      return { code: 0, delivered: watch.delivered, finished: watch.finished };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      await log(text).catch(() => {});
      watch.error = text;
      return { code: 1, delivered: watch.delivered, finished: false, apiError: text };
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}
