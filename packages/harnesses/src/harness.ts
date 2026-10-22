import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import type { AgentRun, RunOutcome, RunWatch } from "./agent.js";
import type { TranscriptLine } from "./transcript.js";

/** What a harness decides before it spawns: how to call its binary, and what to feed it. */
export interface Launch {
  args: string[];
  /** Written to the process's stdin, then closed. Leave it off to pass the message in `args` instead. */
  stdin?: string;
  /** The directory to run in; `run.cwd` when left out, and the dispatcher's own when that is too. */
  cwd?: string;
  /** Environment variables added to the run's own. */
  env?: Record<string, string>;
}

/**
 * A coding-agent CLI that can run a bot's sessions (Claude Code, Cursor, ...). To add one, subclass this, fill in
 * `name`, `label`, `command`, `launch` and `watch`, then add it to harnesses/index.ts and its label to labels.ts.
 * `before` and `after` are for harnesses that need files set up around a run; everything else (the spawn, the log,
 * the outcome) is done here.
 */
export abstract class Harness {
  /** What a bot's `harness` is set to. */
  abstract readonly name: string;
  /** What people read it as (the site's "Claude Code"); set from labels.ts. */
  abstract readonly label: string;
  /** The binary to spawn. */
  abstract readonly command: string;
  /** Whether a run's `allowedTools` / `deniedTools` are enforced; false means a prompt is the only limit. */
  readonly enforcesTools: boolean = false;

  /** Whether `model` is one this harness takes (a bot's model is checked against its harness). */
  abstract modelFits(model: string): boolean;

  /** Runs before the process starts, so a harness can write the files it wants (an MCP config, say). */
  async before(run: AgentRun): Promise<void> {
    void run;
  }

  /** Runs once the process has ended, whether or not the run worked. */
  async after(run: AgentRun): Promise<void> {
    void run;
  }

  abstract launch(run: AgentRun): Launch | Promise<Launch>;

  /** A fresh watch for one run; `onStarted` is for it to call once the session exists. */
  abstract watch(onStarted?: () => void): RunWatch;

  /**
   * Whether a session log ends in a finished run, as opposed to one cut off (the runner died, the machine slept).
   * A log holds every run of the session, so only its last record says how the latest one ended: a finished run
   * ends on the record its watch marks `finished` (Claude's `result`, Codex's `turn.completed`), and a cut-off one
   * on anything else. An empty log is cut off.
   */
  runFinished(log: string): boolean {
    const last = log.trimEnd().split("\n").at(-1);
    if (!last) return false;
    const watch = this.watch();
    watch.line(last);
    return watch.finished;
  }

  /** Turns a session log (what `run` appended to the log, stdout and stderr) into the lines the runner's thread view shows. */
  abstract transcript(log: string): TranscriptLine[];

  /** Runs the session headless, appending the process's stdout to the log. */
  async run(run: AgentRun): Promise<RunOutcome> {
    await mkdir(dirname(run.logPath), { recursive: true, mode: 0o700 });
    // Plain descriptors: a FileHandle that is never closed (or closed mid-write) is a fatal error on newer Node.
    const errFd = openSync(run.logPath, "a", 0o600);
    try {
      await this.before(run);
      const launch = await this.launch(run);
      const child = spawn(this.command, launch.args, {
        env: launch.env ? { ...run.env, ...launch.env } : run.env,
        cwd: launch.cwd ?? run.cwd,
        stdio: [launch.stdin === undefined ? "ignore" : "pipe", "pipe", errFd],
      });
      if (launch.stdin !== undefined) {
        // A process that exits without reading its stdin closes the pipe: that is its call, not an error here.
        child.stdin!.on("error", (e: NodeJS.ErrnoException) => {
          if (e.code !== "EPIPE") child.emit("error", e);
        });
        child.stdin!.end(launch.stdin);
      }
      // stdout goes to the log as before, and through the watch on the way.
      const watch = this.watch(run.onStarted);
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
      await this.after(run).catch(() => {});
    }
  }
}
