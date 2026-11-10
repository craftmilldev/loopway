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
