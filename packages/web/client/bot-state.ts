import type { Runner, Thread } from "./lw.js";

export type BotState = "stranded" | "limited" | "working" | "waiting" | "idle";

/**
 * Where a bot stands, from its threads and the runners. The first that holds wins:
 * stranded (an active thread is owned by a runner whose lease has expired), limited (an active thread hit a usage
 * limit), working (a thread has inflight messages), waiting (active threads, nothing inflight), idle.
 */
export function botState(
  threads: Pick<Thread, "status" | "runner_id" | "limited" | "inflight">[],
  runners: Pick<Runner, "id" | "leased_until">[],
): BotState {
  const active = threads.filter((t) => t.status === "active");
  const offline = new Set(runners.filter((r) => !r.leased_until).map((r) => r.id));
  if (active.some((t) => t.runner_id && offline.has(t.runner_id))) return "stranded";
  if (active.some((t) => t.limited)) return "limited";
  if (active.some((t) => t.inflight.length)) return "working";
  return active.length ? "waiting" : "idle";
}
