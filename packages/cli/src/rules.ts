import { DEFAULT_MAX_BOT_TURNS, type Bot } from "./bots.js";
import type { Subject, Update } from "./source.js";
import { holds, markerOf, repoOf, type Thread } from "./thread.js";

/** Something the poller saw: a subject it just found, or an update to one it knows. */
export type RuleEvent =
  | { type: "new"; subject: Subject }
  | { type: "update"; subject: Subject; update: Update }
  | { type: "created"; thread: string; subject: Subject; subscribe: boolean };

/** What the rules decide. Applying them is `Threads`' job. */
export type Action =
  | { type: "open"; bot: string; subject: Subject; pending: Update[] }
  | { type: "track"; thread: string; subject: Subject }
  | { type: "queue"; thread: string; subject: string; update: Update }
  | { type: "mark"; thread: string; subject: string; status: "open" | "closed" }
  | { type: "close"; thread: string }
  /** A comment or review from someone the bot does not trust: it is not queued, only noted. */
  | { type: "ignore"; thread: string; subject: string; update: Update }
  /** The loop guard: a comment from the bot user past the thread's limit. It is recorded, not queued. */
  | { type: "guard"; thread: string; subject: string; update: Update };

/** Who a bot listens to, and whose work it starts. Without one, every bot trusts everyone and no assignment is needed. */
export interface Trust {
  /** Your `gh` login: work starts only on what is assigned to you. */
  owner: string;
  /** Whether `bot` listens to `login`: its `trusted` list with teams resolved, plus you and the bot user. */
  trusts(bot: string, login: string): boolean;
  /** The bot user's login, when it differs from yours. Its comments count toward the loop guard. */
  botUser?: string;
}

/**
 * The rules, as a pure function: what to do about this event, given the threads and bots there are.
 *
 * - A new subject starts a thread for each bot that wants its kind (`on:`) in its repo, trusts its author, and sees it
 *   assigned to you. A subject that is not assigned yet is known, and gets its threads when it is assigned to you.
 *   With a `trust`, that is the rule; without one, every subject starts them.
 * - A comment or review from a login the bot does not trust is not queued for it.
 * - The loop guard: once a thread has taken `max_bot_turns` comments from the bot user with none from a person in
 *   between, the next ones are recorded (`guard`) but not queued. A person's comment starts the count again.
 * - An update goes on the queue of every open thread holding the subject, except a comment that thread sent itself. A subject closing or merging is marked on
 *   the thread, and the thread closes when none of its subjects is open. A subject reopening is marked open again.
 * - A subject a thread created (told by the tool, or found by the marker in its text) joins that thread, unless the
 *   thread created it with `subscribe: false` (it then has no marker and the thread never holds it), and starts a
 *   thread for every bot that wants its kind, the creator's own included, with its creation as their first update. A
 *   pull request needs no assignment, since its creator is already watching it; an issue does, so that the thread can
 *   choose between filing it and starting work.
 * - A bot with no open thread on the subject starts one when the subject reopens (its old thread closed), or when it
 *   never had one for a subject it already knew.
 */
export function decide(event: RuleEvent, threads: Thread[], bots: Bot[], trust?: Trust): Action[] {
  if (event.type === "created") return created(event.thread, event.subject, threads, bots, trust, event.subscribe);
  if (event.type === "new") {
    const maker = threads.find((t) => t.status === "open" && event.subject.body?.includes(markerOf(t.id)));
    if (maker) return created(maker.id, event.subject, threads, bots, trust);
    return startThreads(
      event.subject,
      never(event.subject, threads, bots),
      [],
      trust,
      assignedToOwner(event.subject, trust),
    );
  }
  const { subject, update } = event;
  const open = threads.filter((t) => t.status === "open" && holds(t, subject.key));
  const limit = (t: Thread) => bots.find((b) => b.name === t.bot)?.maxBotTurns ?? DEFAULT_MAX_BOT_TURNS;
  const following = open.flatMap((t) => follow(t, subject.key, update, limit(t), trust));
  return [...following, ...startThreadsForUpdate(subject, update, threads, bots, trust)];
}

/** A thread created the subject: it tracks it (unless it chose not to subscribe), and every bot that wants the kind gets a thread. Told twice changes nothing. */
function created(
  threadId: string,
  subject: Subject,
  threads: Thread[],
  bots: Bot[],
  trust?: Trust,
  subscribe = true,
): Action[] {
  const maker = threads.find((t) => t.id === threadId);
  if (!maker || holds(maker, subject.key)) return [];
  const creation: Update = {
    id: `created:${subject.key}`,
    kind: "created",
    actor: subject.author,
    at: subject.createdAt,
  };
  const track: Action[] = subscribe && maker.status === "open" ? [{ type: "track", thread: maker.id, subject }] : [];
  const assigned = subject.kind === "pull_request" || assignedToOwner(subject, trust);
  return [...track, ...startThreads(subject, bots, [creation], trust, assigned)];
}

/** An open thread takes the update, and notes the subject closing or reopening. */
function follow(thread: Thread, key: string, update: Update, maxTurns: number, trust?: Trust): Action[] {
  if (update.body?.includes(markerOf(thread.id))) return [];
  // Only words and verdicts can steer a session, so only they are held back: a close, a label or a CI result still goes through.
  if ((update.body || update.kind === "review") && trust && !trust.trusts(thread.bot, update.actor))
    return [{ type: "ignore", thread: thread.id, subject: key, update }];
  const fromBot = isBotWords(update, trust);
  if (fromBot && (thread.botTurns ?? 0) >= maxTurns)
    return [{ type: "guard", thread: thread.id, subject: key, update }];
  const queue: Action = { type: "queue", thread: thread.id, subject: key, update };
  if (update.kind === "reopened") return [queue, { type: "mark", thread: thread.id, subject: key, status: "open" }];
  if (!isClosing(update)) return [queue];
  const mark: Action = { type: "mark", thread: thread.id, subject: key, status: "closed" };
  const othersClosed = thread.subjects.every((s) => s.key === key || s.status === "closed");
  return othersClosed ? [queue, mark, { type: "close", thread: thread.id }] : [queue, mark];
}

function startThreadsForUpdate(
  subject: Subject,
  update: Update,
  threads: Thread[],
  bots: Bot[],
  trust?: Trust,
): Action[] {
  if (isClosing(update)) return [];
  // What was known of the assignees when the subject was found, or the assignment this update reports.
  const assigned =
    assignedToOwner(subject, trust) || (update.kind === "assigned" && sameLogin(update.detail, trust?.owner));
  // Reopened after its thread closed: a new thread. Known but never given a thread: one now.
  if (update.kind === "reopened")
    return startThreads(subject, withoutOpen(subject, threads, bots), [update], trust, assigned);
  // Assigning to you is how an issue a thread only filed gets worked: its creator's hold on it doesn't count.
  const reported = update.kind === "assigned" && sameLogin(update.detail, trust?.owner);
  const candidates = reported ? withoutWorker(subject, threads, bots) : never(subject, threads, bots);
  return startThreads(subject, candidates, [], trust, assigned);
}

/** Words (a comment, or a review) from the bot user. Only these count toward the loop guard. */
export const isBotWords = (update: Update, trust?: Trust) =>
  (!!update.body || update.kind === "review") && sameLogin(update.actor, trust?.botUser);

const sameLogin = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Whether the subject was assigned to you when it was read. Without a `trust` nothing needs assigning. */
const assignedToOwner = (subject: Subject, trust?: Trust) =>
  !trust || (subject.assignees ?? []).some((a) => sameLogin(a, trust.owner));

/** One thread for each of these bots that reads the subject's repo, wants its kind and trusts its author, once assigned. */
function startThreads(
  subject: Subject,
  bots: Bot[],
  pending: Update[],
  trust: Trust | undefined,
  assigned: boolean,
): Action[] {
  if (!assigned) return [];
  const wanting = bots.filter(
    (b) =>
      b.repos.includes(repoOf(subject)) &&
      b.on.includes(subject.kind) &&
      (!trust || trust.trusts(b.name, subject.author)),
  );
  return wanting.map((b) => ({ type: "open", bot: b.name, subject, pending }));
}

/** Bots with no open thread on the subject. */
const withoutOpen = (subject: Subject, threads: Thread[], bots: Bot[]) =>
  bots.filter((b) => !threads.some((t) => t.bot === b.name && t.status === "open" && holds(t, subject.key)));

/** Bots with no thread on the subject except ones that only created it. */
const withoutWorker = (subject: Subject, threads: Thread[], bots: Bot[]) =>
  bots.filter(
    (b) => !threads.some((t) => t.bot === b.name && t.subjects.some((s) => s.key === subject.key && !s.created)),
  );

/** Bots that never had a thread on the subject, open or closed. */
const never = (subject: Subject, threads: Thread[], bots: Bot[]) =>
  bots.filter((b) => !threads.some((t) => t.bot === b.name && holds(t, subject.key)));

const isClosing = (update: Update) => update.kind === "closed" || update.kind === "merged";
