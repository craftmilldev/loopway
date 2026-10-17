import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRun, RunOutcome } from "@loopway/harnesses";
import type { PluginBbSdk, PluginKvStorage } from "@get-bb/plugin-sdk";

/** What a new bb thread needs to know about the loopway thread it stands in for. */
export interface LoopwayThreadInfo {
  /** The bot's prompt, for a thread that has to start over in a new bb thread. */
  prompt: string;
  /** The bb thread's title, e.g. "reviewer: owner/repo#12". */
  title?: string;
}

export interface SessionsOptions {
  threads: Pick<PluginBbSdk["threads"], "spawn" | "send" | "get">;
  kv: PluginKvStorage;
  /** The bb project new threads start in. */
  projectId: string;
  /** Looks up the loopway thread's bot prompt and a title, when a bb thread has to be made for it. */
  describe: (loopwayThreadId: string) => Promise<LoopwayThreadInfo | undefined>;
  log: (text: string) => void;
  /** How often a run checks on its bb thread when no lifecycle event has woken it. */
  pollMs?: number;
  /** Aborts every run's wait, for when the runner stops; their outcomes never come (see `run`). */
  signal: AbortSignal;
}

const threadKey = (loopwayThreadId: string) => `thread:${loopwayThreadId}`;
const bbKey = (bbThreadId: string) => `bb:${bbThreadId}`;

/** Read in the agent tools and `configure`: the plugin metadata a mapped bb thread carries. */
export const METADATA_KEY = "loopwayThreadId";

/**
 * Stands in for the harnesses `loopway bots run` starts: each loopway thread is one bb thread, kept in a
 * two-way map in the plugin's kv. A run for a thread with no bb thread yet spawns one with the message as
 * its prompt; a run for one that has a bb thread sends the message to it. Either way the run lasts until
 * the bb thread is idle again with nothing queued, as a `claude -p` run lasts until the session's turn ends.
 *
 * A run also writes a small transcript at the dispatcher's `logPath`: an `init` record once the bb thread
 * has the message and a `result` record when its turn is over. That's what the dispatcher's reconcile
 * reads to find runs a previous runner was cut off in (bb restarted, the plugin reloaded) and requeue them.
 */
export class BbSessions {
  /** bb thread id → wakes the run waiting on it, when a lifecycle event says it may be done. */
  private readonly waiting = new Map<string, () => void>();
  /** bb threads deleted while this runner had a run waiting on them. */
  private readonly deleted = new Set<string>();

  constructor(private readonly opts: SessionsOptions) {}

  /** The bb thread standing in for the loopway thread, if it has one. */
  async bbThreadFor(loopwayThreadId: string): Promise<string | undefined> {
    return this.opts.kv.get<string>(threadKey(loopwayThreadId));
  }

  /** The loopway thread a bb thread stands in for, if it is one. */
  async loopwayThreadFor(bbThreadId: string): Promise<string | undefined> {
    return this.opts.kv.get<string>(bbKey(bbThreadId));
  }

  /** Every loopway thread → bb thread pair. */
  async pairs(): Promise<{ loopwayThreadId: string; bbThreadId: string }[]> {
    const keys = await this.opts.kv.list("thread:");
    const pairs = await Promise.all(
      keys.map(async (key) => ({
        loopwayThreadId: key.slice("thread:".length),
        bbThreadId: (await this.opts.kv.get<string>(key)) ?? "",
      })),
    );
    return pairs.filter((p) => p.bbThreadId);
  }

  /** A bb thread went idle or failed: the run waiting on it, if any, checks whether it's done. */
  poke(bbThreadId: string): void {
    this.waiting.get(bbThreadId)?.();
  }

  /** A bb thread was deleted: its loopway thread starts over in a new bb thread next time. */
  async forget(bbThreadId: string): Promise<void> {
    const loopwayThreadId = await this.loopwayThreadFor(bbThreadId);
    if (!loopwayThreadId) return;
    this.deleted.add(bbThreadId);
    await this.opts.kv.delete(bbKey(bbThreadId));
    if ((await this.bbThreadFor(loopwayThreadId)) === bbThreadId) await this.opts.kv.delete(threadKey(loopwayThreadId));
    this.poke(bbThreadId);
  }

  /** The dispatcher's `runAgent`. */
  run = async (run: AgentRun): Promise<RunOutcome> => {
    let bbThreadId: string;
    let text = run.message;
    try {
      const existing = await this.liveThread(run.sessionId);
      if (existing) {
        await this.opts.threads.send({
          threadId: existing,
          mode: "auto",
          input: [{ type: "text", text, mentions: [] }],
        });
        bbThreadId = existing;
      } else {
        const info = await this.opts.describe(run.sessionId);
        // A thread that ran before, in a bb thread since deleted, or under the CLI runner: start it over.
        if (run.resume) text = [info?.prompt, STARTED_OVER, text].filter(Boolean).join("\n\n");
        const thread = await this.opts.threads.spawn({
          projectId: this.opts.projectId,
          environment: { type: "project-default" },
          prompt: text,
          ...(info?.title ? { title: info.title } : {}),
          pluginMetadata: { [METADATA_KEY]: run.sessionId },
        });
        bbThreadId = thread.id;
        await this.opts.kv.set(threadKey(run.sessionId), bbThreadId);
        await this.opts.kv.set(bbKey(bbThreadId), run.sessionId);
        this.opts.log(`loopway thread ${run.sessionId.slice(0, 8)} → bb thread ${bbThreadId}`);
      }
    } catch (err) {
      // Retried with the dispatcher's API-error backoff, with the messages put back to waiting.
      return { code: -1, delivered: false, apiError: err instanceof Error ? err.message : String(err) };
    }
    await this.record(run.logPath, { type: "system", subtype: "init", bb_thread_id: bbThreadId });
    await this.record(run.logPath, { type: "user", message: { content: text } });
    run.onStarted?.();

    const status = await this.settle(bbThreadId);
    await this.record(run.logPath, { type: "result", subtype: status, bb_thread_id: bbThreadId });
    return { code: status === "success" ? 0 : 1, delivered: true, finished: true };
  };

  /** The loopway thread's bb thread, unless it has none or it was deleted. */
  private async liveThread(loopwayThreadId: string): Promise<string | undefined> {
    const id = await this.bbThreadFor(loopwayThreadId);
    if (!id || this.deleted.has(id)) return undefined;
    try {
      const thread = await this.opts.threads.get({ threadId: id });
      if (!thread.deletedAt) return id;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    await this.forget(id);
    return undefined;
  }

  /**
   * Waits until the bb thread is idle (or failed) with nothing left in its queue, so the message this run
   * sent has had its turn. Lifecycle events wake it early; a poll covers any it missed. When the runner
   * stops it never returns: the run is left cut off, for the next runner's reconcile to pick up.
   * Right after a send or spawn the thread may still read idle, so idle only counts once the thread has been
   * seen working, or has stayed idle through a few polls (the message was taken and answered between two).
   */
  private async settle(bbThreadId: string): Promise<"success" | "error" | "deleted"> {
    const pollMs = this.opts.pollMs ?? 10_000;
    let idlePolls = 0;
    let sawWork = false;
    try {
      for (;;) {
        const woken = new Promise<void>((resolve) => this.waiting.set(bbThreadId, resolve));
        const timer = new AbortController();
        const stop = () => timer.abort();
        this.opts.signal.addEventListener("abort", stop, { once: true });
        await Promise.race([woken, sleep(pollMs, undefined, { signal: timer.signal }).catch(() => {})]);
        timer.abort();
        this.opts.signal.removeEventListener("abort", stop);
        if (this.opts.signal.aborted) return await new Promise<never>(() => {});
        if (this.deleted.has(bbThreadId)) return "deleted";
        let thread;
        try {
          thread = await this.opts.threads.get({ threadId: bbThreadId });
        } catch (err) {
          if (isNotFound(err)) return "deleted";
          continue; // try again next poll
        }
        if (thread.deletedAt) return "deleted";
        if (thread.queuedMessageCount > 0) {
          sawWork = true;
          continue;
        }
        if (thread.status === "idle") {
          if (sawWork || ++idlePolls >= IDLE_POLLS_BEFORE_DONE) return "success";
          continue;
        }
        sawWork = true;
        if (thread.status === "error") return "error";
      }
    } finally {
      this.waiting.delete(bbThreadId);
    }
  }

  private async record(path: string, record: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, JSON.stringify(record) + "\n", { mode: 0o600 });
    } catch (err) {
      // Only reconcile reads it; a log that can't be written shouldn't stop the run.
      this.opts.log(`couldn't write ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const IDLE_POLLS_BEFORE_DONE = 3;

function isNotFound(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 404 || (err instanceof Error && /\bnot found\b/i.test(err.message));
}

const STARTED_OVER =
  "This loopway thread ran before in another session that is no longer available, so you are starting fresh. Check the thread's subjects on GitHub for what has happened so far.";
