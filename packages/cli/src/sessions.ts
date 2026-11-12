import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  allow,
  askLabel,
  callKey,
  deny,
  describeInput,
  openAsks,
  permissionComment,
  questionComment,
  ruleDecision,
  waitingMessage,
  wasApproved,
  type Ask,
  type PermissionResult,
} from "./asks.js";
import type { Bot } from "./bots.js";
import type { RunAgent, RunOutcome } from "./claude.js";
import type { SessionEvent } from "./format.js";
import { abortableSleep } from "./poller.js";
import type { Made, Subject } from "./source.js";
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
  "comment with gh or the API. Open issues and pull requests only through mcp__loopway__create_issue(repo, title, body) " +
  "and mcp__loopway__create_pr(repo, head, base, title, body), never with gh: loopway tracks what you open and starts " +
  "threads for it. Push a pull request's branch with git first. Comment only when you have something new to say: you " +
  "did work, found a problem, disagree, or need an answer. A turn with nothing to do ends without a comment; never post " +
  "an acknowledgement, thanks or 'nothing to do', since other bots read every comment and answer it. Use gh and git " +
  "for the rest; they act as loopway-bot. " +
  "When you need someone to decide, or you are stuck, call mcp__loopway__ask(subject, question) and end your turn: " +
  "you are resumed with the answer. If a tool call is refused because loopway asked about it, end your turn too.";
const REMINDER =
  "Reminder: talk only through mcp__loopway__comment, and only when you have something new to say. If these updates " +
  "need nothing from you, end your turn without a comment.";

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
  /** Posts and opens things as the bot user. */
  github: {
    comment(subject: string, body: string): Promise<string>;
    createIssue(repo: string, title: string, body: string): Promise<Made>;
    createPr(repo: string, head: string, base: string, title: string, body: string): Promise<Made>;
  };
  /** Told after a thread created a subject, once it is recorded as sent: the rest of loopway takes it in. */
  created: (thread: string, subject: Subject) => Promise<void>;
  emit: (event: SessionEvent) => void;
  now?: () => number;
  newSessionId?: () => string;
  newAskId?: () => string;
}

/**
 * Hands each open thread's queued updates to its Claude Code session, one run at a time per thread and at most `max`
 * at once. A delivered batch leaves the queue; a run that fails leaves it, and the thread waits before trying again.
 * A usage limit holds every thread until it resets.
 */
export class Sessions {
  private readonly running = new Map<string, Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private readonly asking = new Map<string, Promise<unknown>>();
  private heldUntil = 0;
  /** Aborts when loopway stops, which stops the runs in flight. */
  private stopped?: AbortSignal;
  private readonly now: () => number;
  private readonly newSessionId: () => string;
  private readonly newAskId: () => string;

  constructor(private readonly o: SessionsOptions) {
    this.now = o.now ?? Date.now;
    this.newSessionId = o.newSessionId ?? randomUUID;
    this.newAskId = o.newAskId ?? (() => randomUUID().slice(0, 8));
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
    return this.send(this.thread(threadId), subject, body, "comment");
  }

  /** What the `ask` tool does: posts the question and blocks the thread until the owner answers on the subject. */
  async ask(threadId: string, subject: string, question: string): Promise<string> {
    const thread = this.thread(threadId);
    return this.serially(thread, async () => {
      const url = await this.send(thread, subject, questionComment(question), "question");
      await this.block(thread, "question", subject, url, "ask", question);
      return url;
    });
  }

  /**
   * What the `permission` tool does: a call Claude Code would still prompt for. The call the owner approved before
   * passes, then the bot's `deny` and `allow` rules decide. If they don't, the owner is asked on the thread's main
   * subject, and the call is refused for now: the thread is blocked until a reaction answers.
   */
  async permission(threadId: string, tool: string, input: unknown): Promise<PermissionResult> {
    const thread = this.thread(threadId);
    const bot = this.botOf(thread);
    const rule = wasApproved(thread, tool, input) ? "allow" : ruleDecision(bot, tool, input);
    if (rule) this.log(thread, `${rule === "allow" ? "allowed" : "denied"} ${tool} ${describeInput(input)}`);
    if (rule === "allow") return allow(input);
    if (rule === "deny") return deny(`${tool} is denied by the rules of ${bot.name}`);
    return this.serially(thread, () => this.askPermission(thread, tool, input));
  }

  /** Asks once: a call already waiting on an answer is refused again without another comment. */
  private async askPermission(thread: Thread, tool: string, input: unknown): Promise<PermissionResult> {
    const waiting = openAsks(thread).find(
      (a) => a.kind === "permission" && callKey(a.tool, a.input) === callKey(tool, input),
    );
    if (waiting) return deny(waitingMessage(waiting));
    const subject = thread.subjects[0]!.key;
    const url = await this.send(thread, subject, permissionComment(tool, input), "permission");
    return deny(waitingMessage(await this.block(thread, "permission", subject, url, tool, input)));
  }

  /** Records an open ask on the thread and blocks its session. */
  private async block(thread: Thread, kind: Ask["kind"], subject: string, url: string, tool: string, input: unknown) {
    const at = new Date(this.now()).toISOString();
    const ask: Ask = { id: this.newAskId(), kind, commentUrl: url, subject, tool, input, at };
    (thread.asks ??= []).push(ask);
    (thread.session ??= { id: null, status: "idle", lastRunAt: null }).status = "blocked";
    await this.o.threads.save(thread);
    this.log(thread, `?? asked on ${subject}: ${askLabel(ask)} ${url}`);
    this.o.emit({ type: "asked", at, thread: thread.id, what: askLabel(ask), url });
    return ask;
  }

  /** Runs `step` after the thread's earlier asks, so two calls for the same thing never both post. */
  private serially<T>(thread: Thread, step: () => Promise<T>): Promise<T> {
    const done = (this.asking.get(thread.id) ?? Promise.resolve()).then(step);
    this.asking.set(
      thread.id,
      done.catch(() => {}),
    );
    return done;
  }

  private thread(id: string): Thread {
    const thread = this.o.threads.all.find((t) => t.id === id);
    if (!thread) throw new Error(`there is no thread ${id}`);
    return thread;
  }

  private botOf(thread: Thread): Bot {
    const bot = this.o.bots.find((b) => b.name === thread.bot);
    if (!bot) throw new Error(`there is no bot ${thread.bot} in .loopway/`);
    return bot;
  }

  /** Posts as the bot with the thread's marker, records it as sent, logs it, and says so. */
  private async send(thread: Thread, subject: string, body: string, kind: string): Promise<string> {
    if (!SUBJECT.test(subject)) throw new Error(`"${subject}" is not a subject; write it as owner/repo#N`);
    if (!this.botOf(thread).repos.includes(repoOf({ key: subject })))
      throw new Error(`${thread.bot} does not read ${repoOf({ key: subject })}`);
    const post = this.o.github.comment(subject, `${body}\n\n${markerOf(thread.id)}`);
    const url = await this.loggedIfRefused(thread, `${kind} on ${subject}`, post);
    const at = await this.recordSent(thread, subject, kind, url, `${kind} on ${subject}`);
    this.o.emit({ type: "sent", at, thread: thread.id, subject, url });
    return url;
  }

  /** Every message a thread sends is recorded here: in `sent`, on disk, and in the log. Resolves to the time. */
  private async recordSent(thread: Thread, subject: string, kind: string, url: string, what: string): Promise<string> {
    const at = new Date(this.now()).toISOString();
    (thread.sent ??= []).push({ at, subject, kind, url });
    await this.o.threads.save(thread);
    this.log(thread, `<- ${what}`);
    return at;
  }

  /** What the `create_issue` tool does for a thread: opens the issue with the thread's marker, then the thread tracks it. */
  async createIssue(threadId: string, repo: string, title: string, body: string): Promise<Made> {
    const thread = this.thread(threadId);
    this.mayWriteTo(thread, repo);
    const open = this.o.github.createIssue(repo, title, `${body}\n\n${markerOf(thread.id)}`);
    return this.tracked(thread, await this.loggedIfRefused(thread, `create_issue in ${repo}`, open));
  }

  /** What the `create_pr` tool does for a thread: opens the pull request with the thread's marker, then the thread tracks it. */
  async createPr(
    threadId: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<Made> {
    const thread = this.thread(threadId);
    this.mayWriteTo(thread, repo);
    const open = this.o.github.createPr(repo, head, base, title, `${body}\n\n${markerOf(thread.id)}`);
    return this.tracked(thread, await this.loggedIfRefused(thread, `create_pr in ${repo}`, open));
  }

  /** Records a subject the thread created as sent, and lets the rest of loopway take it in. */
  private async tracked(thread: Thread, made: Made): Promise<Made> {
    const { subject, url } = made;
    await this.recordSent(thread, subject.key, subject.kind, url, `created ${subject.key}`);
    await this.o.created(thread.id, subject);
    return made;
  }

  private mayWriteTo(thread: Thread, repo: string): void {
    if (!this.botOf(thread).repos.includes(repo)) throw new Error(`${thread.bot} does not read ${repo}`);
  }

  /** The session hears about a refusal, but so should whoever reads the log. */
  private async loggedIfRefused<T>(thread: Thread, what: string, request: Promise<T>): Promise<T> {
    return request.catch((err: Error) => {
      this.log(thread, `!! ${what} failed: ${err.message}`);
      throw err;
    });
  }

  private async recover(): Promise<void> {
    for (const thread of this.o.threads.all) {
      if (thread.session?.status !== "running") continue;
      thread.session.status = openAsks(thread).length > 0 ? "blocked" : "idle";
      thread.session.lastError = "loopway stopped during the run";
      await this.o.threads.save(thread);
    }
  }

  private ready(thread: Thread): boolean {
    return (
      thread.status === "open" &&
      thread.session?.status !== "blocked" &&
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
    session.status = openAsks(thread).length > 0 ? "blocked" : "idle";
    await this.o.threads.save(thread);
    this.o.emit({ type: "run_finished", at, thread: thread.id });
    if (sentAMessage) return;
    this.log(thread, "turn ended without a message");
    this.o.emit({ type: "silent_turn", at, thread: thread.id });
  }

  private async fail(thread: Thread, session: Session, error: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    // A run cut off after it asked is still waiting for the answer, and keeps its session to be resumed with it.
    const waiting = openAsks(thread).length > 0;
    session.status = waiting ? "blocked" : "failed";
    session.lastError = error;
    // A run with nothing queued was a first run, and the news was the subject itself: it is told again, as a new session.
    if (thread.queue.length === 0 && !waiting) session.id = null;
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
