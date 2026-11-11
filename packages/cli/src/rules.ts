import type { Bot } from "./bots.js";
import type { Subject, Update } from "./source.js";
import { holds, markerOf, repoOf, type Thread } from "./thread.js";

/** Something the poller saw: a subject it just found, or an update to one it knows. */
export type RuleEvent =
  | { type: "new"; subject: Subject }
  | { type: "update"; subject: Subject; update: Update }
  | { type: "created"; thread: string; subject: Subject };

/** What the rules decide. Applying them is `Threads`' job. */
export type Action =
  | { type: "open"; bot: string; subject: Subject; pending: Update[] }
  | { type: "track"; thread: string; subject: Subject }
  | { type: "queue"; thread: string; subject: string; update: Update }
  | { type: "mark"; thread: string; subject: string; status: "open" | "closed" }
  | { type: "close"; thread: string };

/**
 * The rules, as a pure function: what to do about this event, given the threads and bots there are.
 *
 * - A new subject starts a thread for each bot that wants its kind (`on:`) in its repo.
 * - An update goes on the queue of every open thread holding the subject, except a comment that thread sent itself. A subject closing or merging is marked on
 *   the thread, and the thread closes when none of its subjects is open. A subject reopening is marked open again.
 * - A subject a thread created (told by the tool, or found by the marker in its text) joins that thread, and starts a
 *   thread for every bot that wants its kind, the creator's own included, with its creation as their first update.
 * - A bot with no open thread on the subject starts one when the subject reopens (its old thread closed), or when it
 *   never had one for a subject it already knew.
 */
export function decide(event: RuleEvent, threads: Thread[], bots: Bot[]): Action[] {
  if (event.type === "created") return created(event.thread, event.subject, threads, bots);
  if (event.type === "new") {
    const maker = threads.find((t) => t.status === "open" && event.subject.body?.includes(markerOf(t.id)));
    if (maker) return created(maker.id, event.subject, threads, bots);
    return startThreads(event.subject, never(event.subject, threads, bots), []);
  }
  const { subject, update } = event;
  const open = threads.filter((t) => t.status === "open" && holds(t, subject.key));
  const following = open.flatMap((t) => follow(t, subject.key, update));
  return [...following, ...startThreadsForUpdate(subject, update, threads, bots)];
}

/** A thread created the subject: it tracks it, and every bot that wants the kind gets a thread. Told twice changes nothing. */
function created(threadId: string, subject: Subject, threads: Thread[], bots: Bot[]): Action[] {
  const maker = threads.find((t) => t.id === threadId);
  if (!maker || holds(maker, subject.key)) return [];
  const creation: Update = {
    id: `created:${subject.key}`,
    kind: "created",
    actor: subject.author,
    at: subject.createdAt,
  };
  const track: Action[] = maker.status === "open" ? [{ type: "track", thread: maker.id, subject }] : [];
  return [...track, ...startThreads(subject, bots, [creation])];
}

/** An open thread takes the update, and notes the subject closing or reopening. */
function follow(thread: Thread, key: string, update: Update): Action[] {
  if (update.body?.includes(markerOf(thread.id))) return [];
  const queue: Action = { type: "queue", thread: thread.id, subject: key, update };
  if (update.kind === "reopened") return [queue, { type: "mark", thread: thread.id, subject: key, status: "open" }];
  if (!isClosing(update)) return [queue];
  const mark: Action = { type: "mark", thread: thread.id, subject: key, status: "closed" };
  const othersClosed = thread.subjects.every((s) => s.key === key || s.status === "closed");
  return othersClosed ? [queue, mark, { type: "close", thread: thread.id }] : [queue, mark];
}

function startThreadsForUpdate(subject: Subject, update: Update, threads: Thread[], bots: Bot[]): Action[] {
  if (isClosing(update)) return [];
  // Reopened after its thread closed: a new thread. Known but never given a thread: one now.
  if (update.kind === "reopened") return startThreads(subject, withoutOpen(subject, threads, bots), [update]);
  return startThreads(subject, never(subject, threads, bots), []);
}

/** One thread for each of these bots that reads the subject's repo and wants its kind. */
function startThreads(subject: Subject, bots: Bot[], pending: Update[]): Action[] {
  const wanting = bots.filter((b) => b.repos.includes(repoOf(subject)) && b.on.includes(subject.kind));
  return wanting.map((b) => ({ type: "open", bot: b.name, subject, pending }));
}

/** Bots with no open thread on the subject. */
const withoutOpen = (subject: Subject, threads: Thread[], bots: Bot[]) =>
  bots.filter((b) => !threads.some((t) => t.bot === b.name && t.status === "open" && holds(t, subject.key)));

/** Bots that never had a thread on the subject, open or closed. */
const never = (subject: Subject, threads: Thread[], bots: Bot[]) =>
  bots.filter((b) => !threads.some((t) => t.bot === b.name && holds(t, subject.key)));

const isClosing = (update: Update) => update.kind === "closed" || update.kind === "merged";
