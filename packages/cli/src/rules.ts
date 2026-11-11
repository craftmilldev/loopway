import type { Bot } from "./bots.js";
import type { Subject, Update } from "./source.js";
import { holds, markerOf, repoOf, type Thread } from "./thread.js";

/** Something the poller saw: a subject it just found, or an update to one it knows. */
export type RuleEvent = { type: "new"; subject: Subject } | { type: "update"; subject: Subject; update: Update };

/** What the rules decide. Applying them is `Threads`' job. */
export type Action =
  | { type: "open"; bot: string; subject: Subject; pending: Update[] }
  | { type: "queue"; thread: string; subject: string; update: Update }
  | { type: "mark"; thread: string; subject: string; status: "open" | "closed" }
  | { type: "close"; thread: string };

/**
 * The rules, as a pure function: what to do about this event, given the threads and bots there are.
 *
 * - A new subject starts a thread for each bot that wants its kind (`on:`) in its repo.
 * - An update goes on the queue of every open thread holding the subject, except a comment that thread sent itself. A subject closing or merging is marked on
 *   the thread, and the thread closes when none of its subjects is open. A subject reopening is marked open again.
 * - A bot with no open thread on the subject starts one when the subject reopens (its old thread closed), or when it
 *   never had one for a subject it already knew.
 */
export function decide(event: RuleEvent, threads: Thread[], bots: Bot[]): Action[] {
  if (event.type === "new") return startThreads(event.subject, never(event.subject, threads, bots), []);
  const { subject, update } = event;
  const open = threads.filter((t) => t.status === "open" && holds(t, subject.key));
  const following = open.flatMap((t) => follow(t, subject.key, update));
  return [...following, ...startThreadsForUpdate(subject, update, threads, bots)];
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
