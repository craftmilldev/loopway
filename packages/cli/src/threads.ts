import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { askLabel, callKey, openAsks, type Ask } from "./asks.js";
import { DEFAULT_MAX_BOT_TURNS, type Bot } from "./bots.js";
import type { LoopwayEvent, ThreadEvent } from "./format.js";
import { decide, isBotWords, type Action, type Trust } from "./rules.js";
import type { Update } from "./source.js";
import { writeJson } from "./state.js";
import { holds, type Thread } from "./thread.js";

/** Closed threads stay in `loopway threads` this long after their latest message. */
export const CLOSED_SHOWN_MS = 3 * 24 * 60 * 60_000;

export const threadsDir = (dir: string) => join(dir, "threads");

/** The session log of a thread, appended to as its session runs. */
export const threadLogPath = (dir: string, id: string) => join(threadsDir(dir), `${id}.log`);

/** What a thread's session has logged so far; empty until it has. */
export function readThreadLog(dir: string, id: string): string {
  try {
    return readFileSync(threadLogPath(dir, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export async function loadThreads(dir: string): Promise<Thread[]> {
  let files: string[];
  try {
    files = (await readdir(threadsDir(dir))).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const threads = await Promise.all(files.map((f) => readFile(join(threadsDir(dir), f), "utf8")));
  return threads.map((text) => JSON.parse(text) as Thread);
}

/** What `loopway threads` lists: the open threads, and those closed within the last 3 days (by latest message). */
export function visibleThreads(threads: Thread[], now: number): Thread[] {
  const shown = threads.filter((t) => t.status === "open" || now - Date.parse(t.latestAt) <= CLOSED_SHOWN_MS);
  return shown.sort(
    (a, b) => Number(b.status === "open") - Number(a.status === "open") || a.createdAt.localeCompare(b.createdAt),
  );
}

/** The threads holding a subject. */
export const withSubject = (threads: Thread[], key: string) => threads.filter((t) => holds(t, key));

export interface ThreadsOptions {
  /** The project's state directory. */
  dir: string;
  bots: Bot[];
  /** Your `gh` login: only your comment answers a question, and only your reaction a permission ask. */
  owner?: string;
  /** Who the bots listen to. Left out, they listen to everyone and need no assignment. */
  trust?: Trust;
  now?: () => number;
  newId?: () => string;
}

/** Every thread, kept in memory and in `<dir>/threads/<id>.json`. Applies what `decide` says to each event. */
export class Threads {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly writing = new Map<string, Promise<void>>();

  private constructor(
    private readonly o: ThreadsOptions,
    readonly all: Thread[],
  ) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => randomUUID().slice(0, 8));
  }

  static async load(o: ThreadsOptions): Promise<Threads> {
    return new Threads(o, await loadThreads(o.dir));
  }

  /** Acts on an event from the poller: the thread changes are on disk when this returns. */
  async handle(event: LoopwayEvent): Promise<ThreadEvent[]> {
    if (event.type !== "new" && event.type !== "update" && event.type !== "created") return [];
    const touched = new Set<Thread>();
    const events: ThreadEvent[] = [];
    for (const action of decide(event, this.all, this.o.bots, this.o.trust)) {
      const thread = this.apply(action, events);
      touched.add(thread);
    }
    for (const thread of touched) await this.save(thread);
    return events;
  }

  /** Writes the thread's file. Saves of one thread run in turn, so the poller and a session never collide. */
  save(thread: Thread): Promise<void> {
    const after = this.writing.get(thread.id) ?? Promise.resolve();
    const written = after.then(() => writeJson(join(threadsDir(this.o.dir), `${thread.id}.json`), thread));
    this.writing.set(
      thread.id,
      written.catch(() => {}),
    );
    return written;
  }

  private apply(action: Action, events: ThreadEvent[]): Thread {
    if (action.type === "open") return this.open(action, events);
    const thread = this.all.find((t) => t.id === action.thread)!;
    if (action.type === "track") thread.subjects.push({ key: action.subject.key, status: "open", created: true });
    if (action.type === "queue") this.queue(thread, action.subject, action.update, events);
    if (action.type === "queue") this.answerQuestions(thread, action.subject, action.update, events);
    if (action.type === "ignore")
      events.push({ type: "ignored", subject: action.subject, update: action.update, thread: thread.id });
    if (action.type === "guard") this.guard(thread, action.subject, action.update, events);
    if (action.type === "mark") thread.subjects.find((s) => s.key === action.subject)!.status = action.status;
    if (action.type === "close") this.close(thread, events);
    return thread;
  }

  private open(action: Extract<Action, { type: "open" }>, events: ThreadEvent[]): Thread {
    const at = new Date(this.now()).toISOString();
    const thread: Thread = {
      id: this.newId(),
      bot: action.bot,
      subjects: [{ key: action.subject.key, status: "open" }],
      status: "open",
      createdAt: at,
      latestAt: at,
      queue: [],
    };
    this.all.push(thread);
    events.push({ type: "thread_opened", thread });
    for (const update of action.pending) this.queue(thread, action.subject.key, update, events);
    return thread;
  }

  private queue(thread: Thread, subject: string, update: Update, events: ThreadEvent[]) {
    // The loop guard's count: the bot user's words add one, a person's words start it again.
    if (isBotWords(update, this.o.trust)) thread.botTurns = (thread.botTurns ?? 0) + 1;
    else if (update.body || update.kind === "review") {
      delete thread.botTurns;
      delete thread.guarded;
    }
    thread.queue.push({ ...update, subject });
    if (update.at > thread.latestAt) thread.latestAt = update.at;
    events.push({ type: "queued", subject, update, thread: thread.id });
  }

  /** A bot comment past the limit: shown and remembered, never queued, so it starts no run. */
  private guard(thread: Thread, subject: string, update: Update, events: ThreadEvent[]) {
    thread.guarded = true;
    if (update.at > thread.latestAt) thread.latestAt = update.at;
    const limit = this.o.bots.find((b) => b.name === thread.bot)?.maxBotTurns ?? DEFAULT_MAX_BOT_TURNS;
    events.push({ type: "guarded", subject, update, thread: thread.id, limit });
  }

  /** The owner's comment on a subject after a question was asked there answers it. It is queued like any update. */
  private answerQuestions(thread: Thread, subject: string, update: Update, events: ThreadEvent[]) {
    if (update.kind !== "comment" || update.actor.toLowerCase() !== this.o.owner?.toLowerCase()) return;
    for (const ask of openAsks(thread)) {
      if (ask.kind !== "question" || ask.subject !== subject || ask.at >= update.at) continue;
      ask.answeredAt = update.at;
      events.push({ type: "answered", at: update.at, thread: thread.id, what: askLabel(ask), how: "replied" });
    }
    this.unblock(thread);
  }

  /**
   * The owner's 👍 or 👎 on a permission ask. A 👍 is remembered, so the same call passes next time. Either way the
   * session is told on its queue and is no longer blocked.
   */
  async answerPermission(thread: Thread, ask: Ask, approved: boolean, actor: string): Promise<ThreadEvent> {
    const at = new Date(this.now()).toISOString();
    ask.answeredAt = at;
    if (approved)
      ((thread.session ??= { id: null, status: "idle", lastRunAt: null }).approved ??= []).push(
        callKey(ask.tool, ask.input),
      );
    const what = askLabel(ask);
    const verdict = approved ? "approved" : "denied";
    const body = approved ? "Retry it." : "Do not do it. Carry on without it, or say what you need instead.";
    this.queue(thread, ask.subject, { id: `ask:${ask.id}`, kind: verdict, detail: what, body, actor, at }, []);
    this.unblock(thread);
    await this.save(thread);
    return { type: "answered", at, thread: thread.id, what, how: verdict };
  }

  /** A session with nothing left to wait on is idle again. */
  private unblock(thread: Thread) {
    if (thread.session?.status === "blocked" && openAsks(thread).length === 0) thread.session.status = "idle";
  }

  private close(thread: Thread, events: ThreadEvent[]) {
    thread.status = "closed";
    events.push({ type: "thread_closed", thread });
  }
}
