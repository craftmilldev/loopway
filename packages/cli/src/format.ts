import type { Subject, Update } from "./source.js";
import type { Thread } from "./thread.js";

/** What the poller reports: a subject it just found, or something that happened to one it knows. */
export type LoopwayEvent =
  | { type: "new"; subject: Subject }
  | { type: "update"; subject: Subject; update: Update }
  | { type: "created"; thread: string; subject: Subject }
  | ThreadEvent
  | SessionEvent;

/** What the sessions did: runs starting and ending, messages sent, failures. `at` is an ISO time. */
export type SessionEvent =
  | { type: "run_started"; at: string; thread: string; bot: string; delivered: number; resumed: boolean }
  | { type: "run_finished"; at: string; thread: string }
  | { type: "sent"; at: string; thread: string; subject: string; url: string }
  | { type: "silent_turn"; at: string; thread: string }
  | { type: "asked"; at: string; thread: string; what: string; url: string }
  | { type: "run_failed"; at: string; thread: string; error: string; requeued: number };

/** What the threads did about an event. */
export type ThreadEvent =
  | { type: "thread_opened"; thread: Thread }
  | { type: "queued"; subject: string; update: Update; thread: string }
  | { type: "ignored"; subject: string; update: Update; thread: string }
  | { type: "thread_closed"; thread: Thread }
  | { type: "answered"; at: string; thread: string; what: string; how: "approved" | "denied" | "replied" };

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time, `2026-11-10 14:02`. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const subjectKeys = (t: Thread) => t.subjects.map((s) => s.key).join(",");

export function formatLine(event: LoopwayEvent): string {
  switch (event.type) {
    case "new": {
      const s = event.subject;
      const kind = s.kind === "issue" ? "issue" : "pr";
      return `${stamp(s.createdAt)} new    ${s.key} ${kind} ${JSON.stringify(s.title)} by ${s.author}`;
    }
    case "update": {
      const u = event.update;
      const what = u.detail ? `${u.kind} ${u.detail}` : u.kind;
      return `${stamp(u.at)} update ${event.subject.key} ${what} by ${u.actor}`;
    }
    case "created": {
      const s = event.subject;
      const kind = s.kind === "issue" ? "issue" : "pr";
      return `${stamp(s.createdAt)} created ${s.key} ${kind} ${JSON.stringify(s.title)} by thread ${event.thread}`;
    }
    case "thread_opened": {
      const t = event.thread;
      return `${stamp(t.createdAt)} thread opened ${t.id} ${t.bot} ${subjectKeys(t)}`;
    }
    case "queued":
      return `${stamp(event.update.at)} queued ${event.subject} ${event.update.kind} -> ${event.thread}`;
    case "ignored":
      return `${stamp(event.update.at)} ignored ${event.update.kind} on ${event.subject} by ${event.update.actor}, who ${event.thread}'s bot does not trust`;
    case "thread_closed":
      return `${stamp(event.thread.latestAt)} thread closed ${event.thread.id}`;
    case "run_started": {
      const how = event.resumed ? "resumed" : "new session";
      return `${stamp(event.at)} run started ${event.thread} ${event.bot} (${how}), delivered ${event.delivered} updates`;
    }
    case "run_finished":
      return `${stamp(event.at)} run finished ${event.thread}`;
    case "sent":
      return `${stamp(event.at)} sent ${event.thread} comment on ${event.subject} ${event.url}`;
    case "silent_turn":
      return `${stamp(event.at)} turn ended without a message ${event.thread}`;
    case "asked":
      return `${stamp(event.at)} asked ${event.thread} ${event.what} ${event.url}`;
    case "answered":
      return `${stamp(event.at)} answered ${event.thread} ${event.how}: ${event.what}`;
    case "run_failed":
      return `${stamp(event.at)} run failed ${event.thread}: ${event.error}; ${event.requeued} updates back in the queue`;
  }
}

export function formatJson(event: LoopwayEvent): string {
  switch (event.type) {
    case "new": {
      const s = event.subject;
      const { key, kind, title, author } = s;
      return JSON.stringify({ type: "new", time: s.createdAt, subject: key, kind, title, author });
    }
    case "update": {
      const u = event.update;
      return JSON.stringify({
        type: "update",
        time: u.at,
        subject: event.subject.key,
        id: u.id,
        kind: u.kind,
        ...(u.detail ? { detail: u.detail } : {}),
        actor: u.actor,
      });
    }
    case "created": {
      const { key, kind, title } = event.subject;
      return JSON.stringify({
        type: "created",
        time: event.subject.createdAt,
        thread: event.thread,
        subject: key,
        kind,
        title,
      });
    }
    case "thread_opened": {
      const { id, bot, createdAt } = event.thread;
      return JSON.stringify({
        type: "thread_opened",
        time: createdAt,
        thread: id,
        bot,
        subjects: event.thread.subjects.map((s) => s.key),
      });
    }
    case "queued": {
      const { subject, thread, update } = event;
      return JSON.stringify({ type: "queued", time: update.at, subject, id: update.id, kind: update.kind, thread });
    }
    case "ignored": {
      const { subject, thread, update } = event;
      return JSON.stringify({
        type: "ignored",
        time: update.at,
        subject,
        id: update.id,
        kind: update.kind,
        actor: update.actor,
        thread,
      });
    }
    case "thread_closed":
      return JSON.stringify({ type: "thread_closed", time: event.thread.latestAt, thread: event.thread.id });
    default: {
      const { at, ...rest } = event;
      return JSON.stringify({ time: at, ...rest });
    }
  }
}

/** One row of `loopway threads`: id, bot, status, subjects, pending count. */
export const formatThread = (t: Thread) =>
  `${t.id}  ${t.bot.padEnd(8)} ${t.status.padEnd(6)} ${subjectKeys(t)}  ${t.queue.length} pending`;

export const formatThreadJson = (t: Thread) =>
  JSON.stringify({
    id: t.id,
    bot: t.bot,
    status: t.status,
    subjects: t.subjects.map((s) => s.key),
    pending: t.queue.length,
    createdAt: t.createdAt,
    latestAt: t.latestAt,
  });
