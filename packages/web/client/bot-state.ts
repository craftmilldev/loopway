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

/** One line on why a bot is in `state`, from the same threads `botState` read. Empty for idle. */
export function stateReason(state: BotState, threads: Pick<Thread, "status" | "inflight">[]): string {
  if (state === "stranded") return "Its runner is offline";
  if (state === "limited") return "Hit its usage limit";
  if (state === "waiting") return "Waiting for a runner";
  if (state === "working") {
    const n = threads.filter((t) => t.status === "active").reduce((sum, t) => sum + t.inflight.length, 0);
    return `${n} ${n === 1 ? "message" : "messages"} in flight`;
  }
  return "";
}

export type BotFilter = "all" | "stopped" | "working" | "idle";

/** Which filter tab a state is counted under. */
export function filterOf(state: BotState): Exclude<BotFilter, "all"> {
  if (state === "stranded" || state === "limited") return "stopped";
  if (state === "working" || state === "waiting") return "working";
  return "idle";
}
