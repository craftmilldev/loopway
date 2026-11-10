import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bot } from "./bots.js";
import type { LoopwayEvent, ThreadEvent } from "./format.js";
import { decide, type Action } from "./rules.js";
import type { Update } from "./source.js";
import { writeJson } from "./state.js";
import { holds, type Thread } from "./thread.js";

/** Closed threads stay in `loopway threads` this long after their latest message. */
export const CLOSED_SHOWN_MS = 3 * 24 * 60 * 60_000;

export const threadsDir = (home: string) => join(home, "threads");

/** The session log of a thread, appended to as its session runs. */
export const threadLogPath = (home: string, id: string) => join(threadsDir(home), `${id}.log`);

/** What a thread's session has logged so far; empty until it has. */
export function readThreadLog(home: string, id: string): string {
  try {
    return readFileSync(threadLogPath(home, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export async function loadThreads(home: string): Promise<Thread[]> {
  let files: string[];
  try {
    files = (await readdir(threadsDir(home))).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const threads = await Promise.all(files.map((f) => readFile(join(threadsDir(home), f), "utf8")));
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
  home: string;
  bots: Bot[];
  now?: () => number;
  newId?: () => string;
}

/** Every thread, kept in memory and in `<home>/threads/<id>.json`. Applies what `decide` says to each event. */
export class Threads {
  private readonly now: () => number;
  private readonly newId: () => string;

  private constructor(
    private readonly o: ThreadsOptions,
    readonly all: Thread[],
  ) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => randomUUID().slice(0, 8));
  }

  static async load(o: ThreadsOptions): Promise<Threads> {
    return new Threads(o, await loadThreads(o.home));
  }

  /** Acts on an event from the poller: the thread changes are on disk when this returns. */
  async handle(event: LoopwayEvent): Promise<ThreadEvent[]> {
    if (event.type !== "new" && event.type !== "update") return [];
    const touched = new Set<Thread>();
    const events: ThreadEvent[] = [];
    for (const action of decide(event, this.all, this.o.bots)) {
      const thread = this.apply(action, events);
      touched.add(thread);
    }
    for (const thread of touched) await writeJson(join(threadsDir(this.o.home), `${thread.id}.json`), thread);
    return events;
  }

  private apply(action: Action, events: ThreadEvent[]): Thread {
    if (action.type === "open") return this.open(action, events);
    const thread = this.all.find((t) => t.id === action.thread)!;
    if (action.type === "queue") this.queue(thread, action.subject, action.update, events);
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
    thread.queue.push({ ...update, subject });
    if (update.at > thread.latestAt) thread.latestAt = update.at;
    events.push({ type: "queued", subject, update, thread: thread.id });
  }

  private close(thread: Thread, events: ThreadEvent[]) {
    thread.status = "closed";
    events.push({ type: "thread_closed", thread });
  }
}
