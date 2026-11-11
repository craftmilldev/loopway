import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Bot } from "./bots.js";
import type { RunAgent, RunOutcome } from "./claude.js";
import type { SessionEvent } from "./format.js";
import { abortableSleep } from "./poller.js";
import { markerOf, repoOf, type Pending, type Session, type Thread } from "./thread.js";
import { threadLogPath, type Threads } from "./threads.js";

/** How often idle threads are checked for queued updates, besides whenever the poller queues one. */
export const CHECK_EVERY_MS = 15_000;
/** A thread whose run failed waits this long before its updates are tried again. */
export const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

const SUBJECT = /^[\w.-]+\/[\w.-]+#\d+$/;

const GROUND_RULES =
  "You are loopway-bot, working a thread on GitHub. Talk only through loopway's tools: mcp__loopway__comment(subject, " +
  "body) posts a comment on an issue or pull request, and everything you want people to hear goes through it. Never " +
  "comment with gh or the API. Post at least one message on every turn, even if it is only to say there is nothing to " +
  "do. Use gh and git for the rest; they act as loopway-bot.";
const REMINDER = "Reminder: talk only through mcp__loopway__comment, and post at least one message on this turn.";

export interface SessionsOptions {
  /** The project's state directory (see `stateDir`): the thread files and logs live in it. */
  dir: string;
  threads: Threads;
  bots: Bot[];
  /** The directory `loopway` runs in, where every session runs too. */
  root: string;
  /** Runs in flight at once. */
  max: number;
  runAgent: RunAgent;
  /** The MCP endpoint of a thread's session. */
  mcpUrl: (threadId: string) => string;
  /** The bot user as the session sees it: GH_TOKEN and the git author and committer. */
  env: NodeJS.ProcessEnv;
  /** Posts as the bot user. */
  commenter: { comment(subject: string, body: string): Promise<string> };
  emit: (event: SessionEvent) => void;
  now?: () => number;
  newSessionId?: () => string;
}

/**
 * Hands each open thread's queued updates to its Claude Code session, one run at a time per thread and at most `max`
 * at once. A delivered batch leaves the queue; a run that fails leaves it, and the thread waits before trying again.
 * A usage limit holds every thread until it resets.
 */
export class Sessions {
  private readonly running = new Map<string, Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private heldUntil = 0;
  /** Aborts when loopway stops, which stops the runs in flight. */
  private stopped?: AbortSignal;
  private readonly now: () => number;
  private readonly newSessionId: () => string;

  constructor(private readonly o: SessionsOptions) {
    this.now = o.now ?? Date.now;
    this.newSessionId = o.newSessionId ?? randomUUID;
  }

  /** Until `signal` aborts: a run that was cut off by a restart is idle again, then the queues are checked often. */
  async run(signal: AbortSignal, sleep = abortableSleep): Promise<void> {
    this.stopped = signal;
    await this.recover();
    while (!signal.aborted) {
      this.kick();
      await sleep(CHECK_EVERY_MS, signal);
    }
    await this.idle();
  }

  /** Starts a run for every thread that is ready, up to `max`. */
  kick(): void {
    if (this.now() < this.heldUntil) return;
    for (const thread of this.o.threads.all) {
      if (this.running.size >= this.o.max) return;
      if (this.ready(thread)) this.start(thread);
    }
  }

  /** Resolves when no run is in flight. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  /** What the `comment` tool does for a thread: posts it, records it as sent, and says so. */
  async comment(threadId: string, subject: string, body: string): Promise<string> {
    const thread = this.o.threads.all.find((t) => t.id === threadId);
    if (!thread) throw new Error(`there is no thread ${threadId}`);
    if (!SUBJECT.test(subject)) throw new Error(`"${subject}" is not a subject; write it as owner/repo#N`);
    const bot = this.o.bots.find((b) => b.name === thread.bot);
    if (!bot?.repos.includes(repoOf({ key: subject })))
      throw new Error(`${thread.bot} does not read ${repoOf({ key: subject })}`);
    const url = await this.o.commenter.comment(subject, `${body}\n\n${markerOf(thread.id)}`).catch((err: Error) => {
      // The session hears about it, but so should whoever reads the log.
      this.log(thread, `!! comment on ${subject} failed: ${err.message}`);
      throw err;
    });
    const at = new Date(this.now()).toISOString();
    (thread.sent ??= []).push({ at, subject, kind: "comment", url });
    await this.o.threads.save(thread);
    this.log(thread, `<- comment on ${subject}`);
    this.o.emit({ type: "sent", at, thread: thread.id, subject, url });
    return url;
  }

  private async recover(): Promise<void> {
    for (const thread of this.o.threads.all) {
      if (thread.session?.status !== "running") continue;
      thread.session.status = "idle";
      thread.session.lastError = "loopway stopped during the run";
      await this.o.threads.save(thread);
    }
  }

  private ready(thread: Thread): boolean {
    return (
      thread.status === "open" &&
      (thread.queue.length > 0 || !thread.session?.id) &&
      !this.running.has(thread.id) &&
      this.now() >= (this.retryAt.get(thread.id) ?? 0)
    );
  }

  private start(thread: Thread): void {
    const done = this.deliver(thread).then(() => {
      this.running.delete(thread.id);
      this.kick();
    });
    this.running.set(thread.id, done);
  }

  /** One run: everything queued now goes to the session. Never throws; a failure is the thread's `session`. */
  private async deliver(thread: Thread): Promise<void> {
    const batch = [...thread.queue];
    const session = (thread.session ??= { id: null, status: "idle", lastRunAt: null });
    const sentBefore = thread.sent?.length ?? 0;
    try {
      await this.begin(thread, session, batch.length);
      const failure = await this.execute(thread, session, batch);
      if (failure) return await this.fail(thread, session, failure);
      thread.queue.splice(0, batch.length);
      await this.finish(thread, session, (thread.sent?.length ?? 0) > sentBefore);
    } catch (err) {
      await this.fail(thread, session, (err as Error).message).catch(() => {});
    }
  }

  private async begin(thread: Thread, session: Session, delivered: number): Promise<void> {
    const at = new Date(this.now()).toISOString();
    session.status = "running";
    session.lastRunAt = at;
    delete session.lastError;
    await this.o.threads.save(thread);
    this.log(thread, `-> delivered ${delivered} updates`);
    this.o.emit({
      type: "run_started",
      at,
      thread: thread.id,
      bot: thread.bot,
      delivered,
      resumed: session.id !== null,
    });
  }

  /** Runs the session over the batch; the reason it failed, if it did. */
  private async execute(thread: Thread, session: Session, batch: Pending[]): Promise<string | undefined> {
    const bot = this.o.bots.find((b) => b.name === thread.bot);
    if (!bot) return `there is no bot ${thread.bot} in .loopway/`;
    const resume = session.id !== null;
    const sessionId = session.id ?? this.newSessionId();
    const outcome = await this.o.runAgent({
      sessionId,
      resume,
      message: resume ? `${REMINDER}\n\n${updatesText(batch)}` : firstMessage(bot, thread, batch),
      model: bot.model,
      cwd: this.o.root,
      env: { ...process.env, ...this.o.env },
      mcpUrl: this.o.mcpUrl(thread.id),
      signal: this.stopped,
      onLine: (line) => this.log(thread, line),
      onStarted: () => {
        session.id = sessionId;
        void this.o.threads.save(thread);
      },
    });
    return this.failureOf(outcome);
  }

  private failureOf(outcome: RunOutcome): string | undefined {
    if (outcome.limitedUntil) {
      this.heldUntil = outcome.limitedUntil;
      return `usage limit reached, holding every delivery until ${new Date(outcome.limitedUntil).toISOString()}`;
    }
    if (outcome.apiError) return outcome.apiError;
    if (outcome.code !== 0) return `claude exited with code ${outcome.code}`;
    if (!outcome.finished) return "the run ended without a result";
  }

  private async finish(thread: Thread, session: Session, sentAMessage: boolean): Promise<void> {
    const at = new Date(this.now()).toISOString();
    session.status = "idle";
    await this.o.threads.save(thread);
    this.o.emit({ type: "run_finished", at, thread: thread.id });
    if (sentAMessage) return;
    this.log(thread, "turn ended without a message");
    this.o.emit({ type: "silent_turn", at, thread: thread.id });
  }

  private async fail(thread: Thread, session: Session, error: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    session.status = "failed";
    session.lastError = error;
    this.retryAt.set(thread.id, this.now() + RETRY_AFTER_FAILURE_MS);
    await this.o.threads.save(thread);
    this.log(thread, `!! run failed: ${error}`);
    this.o.emit({ type: "run_failed", at, thread: thread.id, error, requeued: thread.queue.length });
  }

  private log(thread: Thread, line: string): void {
    const file = threadLogPath(this.o.dir, thread.id);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, line + "\n");
  }
}

/** A new session is told who it is and what to do, then what happened. */
function firstMessage(bot: Bot, thread: Thread, batch: Pending[]): string {
  const subjects = thread.subjects.map((s) => s.key).join(", ");
  return [GROUND_RULES, bot.prompt, `This thread tracks: ${subjects}. Read them with gh.`, updatesText(batch)].join(
    "\n\n",
  );
}

/** The queued updates, oldest first. */
function updatesText(batch: Pending[]): string {
  // A thread's first run has nothing queued when its subject is brand new: the subject itself is the news.
  if (batch.length === 0)
    return "The thread has just opened and nothing has happened on its subjects yet. Start there.";
  const oldestFirst = [...batch].sort((a, b) => a.at.localeCompare(b.at));
  const lines = oldestFirst.map((u) => {
    const what = u.detail ? `${u.kind} ${u.detail}` : u.kind;
    const head = `- ${u.at} ${u.subject} ${what} by ${u.actor}`;
    return u.body ? `${head}\n${u.body.replace(/^/gm, "    ")}` : head;
  });
  return [`${batch.length} updates since your last turn, oldest first:`, ...lines].join("\n");
}
