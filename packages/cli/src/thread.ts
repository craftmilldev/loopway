import type { Subject, Update } from "./source.js";

/** One bot plus the subjects it tracks. Stored as `<home>/threads/<id>.json`. */
export interface Thread {
  id: string;
  bot: string;
  subjects: { key: string; status: "open" | "closed" }[];
  status: "open" | "closed";
  /** ISO time. */
  createdAt: string;
  /** ISO time of the thread's latest message. */
  latestAt: string;
  /** Updates waiting to be delivered to a session. Slice 3 empties it; for now it only fills. */
  queue: Pending[];
  /** The Claude Code session working the thread. Missing until one has run. */
  session?: Session;
  /** Messages the thread sent out, as recorded by loopway's own tools. */
  sent?: Sent[];
}

export interface Session {
  id: string | null;
  status: "idle" | "running" | "blocked" | "failed";
  /** ISO time. */
  lastRunAt: string | null;
  lastError?: string;
}

/** A message a thread posted: when, on which subject, what kind of message, and where to read it. */
export interface Sent {
  at: string;
  subject: string;
  kind: string;
  url: string;
}

/** An update on the queue, with the subject it happened to. `id` is the update's stable id. */
export type Pending = Update & { subject: string };

export const holds = (thread: Thread, key: string) => thread.subjects.some((s) => s.key === key);

/** `owner/repo` of a subject key `owner/repo#N`. */
export const repoOf = (subject: Pick<Subject, "key">) => subject.key.split("#")[0]!;
