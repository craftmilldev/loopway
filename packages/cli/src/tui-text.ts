import type { PollStatus } from "./poller.js";
import type { Thread } from "./thread.js";
import { stateColors, theme } from "./tui-theme.js";

/** What the session is doing, or that there isn't one. */
export const sessionText = (thread: Thread) => thread.session?.status ?? "no session yet";

export const sessionColor = (thread: Thread): string | undefined => {
  const status = thread.session?.status;
  return status && status !== "idle" ? stateColors[status] : undefined;
};

/** The state of an open thread, which is how the main view groups them: what needs you comes first. */
export type ThreadState = "needs you" | "running" | "failed" | "updates waiting" | "quiet";

const STATE_ORDER: ThreadState[] = ["needs you", "running", "failed", "updates waiting", "quiet"];

export function threadState(thread: Thread): ThreadState {
  const status = thread.session?.status;
  if (status === "blocked") return "needs you";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return thread.queue.length > 0 ? "updates waiting" : "quiet";
}

export interface Group {
  title: string;
  color: string;
  threads: Thread[];
}

/**
 * The rows of the main view: the open threads grouped by state (only the states that have any), then the closed.
 * Threads keep the order they came in within a group.
 */
export function groupThreads(threads: Thread[]): Group[] {
  const colors: Record<ThreadState, string> = {
    "needs you": stateColors.blocked,
    running: stateColors.running,
    failed: stateColors.failed,
    "updates waiting": theme.cream,
    quiet: stateColors.idle,
  };
  const open = threads.filter((t) => t.status !== "closed");
  const groups: Group[] = STATE_ORDER.map((state) => ({
    title: `Open · ${state}`,
    color: colors[state],
    threads: open.filter((t) => threadState(t) === state),
  }));
  groups.push({ title: "Closed", color: theme.land, threads: threads.filter((t) => t.status === "closed") });
  return groups.filter((g) => g.threads.length > 0);
}

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
