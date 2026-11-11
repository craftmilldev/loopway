import type { PollStatus } from "./poller.js";
import type { Thread } from "./thread.js";

/** What the session is doing, or that there isn't one. */
export const sessionText = (thread: Thread) => thread.session?.status ?? "no session yet";

const SESSION_COLORS = { running: "green", blocked: "yellow", failed: "red" } as const;

export const sessionColor = (thread: Thread) => {
  const status = thread.session?.status;
  return status && status !== "idle" ? SESSION_COLORS[status] : undefined;
};

/** The last `n` of a list, newest last, and how many came before them. */
export function lastOf<T>(items: T[], n: number): { shown: T[]; hidden: number } {
  return { shown: items.slice(-n), hidden: Math.max(0, items.length - n) };
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const countdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** What the poller is doing, in a line: `polling o/r · last checked 14:02 · next in 0:24`. */
export function formatPollStatus(repos: string[], poll: PollStatus, now: number): string {
  if (poll.refreshing) return "refreshing…";
  if (now < poll.pausedUntil) return `rate limited · resumes in ${countdown(poll.pausedUntil - now)}`;
  const last = poll.lastCheckedAt === undefined ? "not yet" : clock(poll.lastCheckedAt);
  return `polling ${repos.join(", ")} · last checked ${last} · next in ${countdown(poll.nextAt - now)}`;
}
