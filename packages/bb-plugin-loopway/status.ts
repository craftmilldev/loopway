// What the Loopway page shows: the runner's phase, kept here as it changes, and a snapshot of its bots and
// threads, read from the dispatcher when the page asks.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { DispatcherState } from "@loopway/cli/src/bots/dispatcher.js";

const phaseSchema = z.enum(["starting", "running", "stopped", "needs-configuration", "error"]);
export type Phase = z.infer<typeof phaseSchema>;

const snapshotSchema = z.object({
  runner: z.object({
    phase: phaseSchema,
    /** Why it isn't running, for every phase but `running`. */
    message: z.string().nullable(),
    org: z.string().nullable(),
    runnerId: z.string().nullable(),
    projectId: z.string().nullable(),
    interval: z.number().nullable(),
    max: z.number().nullable(),
    startedAt: z.number().nullable(),
    lastTickAt: z.number().nullable(),
  }),
  bots: z.array(
    z.object({
      name: z.string(),
      harness: z.string(),
      model: z.string(),
    }),
  ),
  /** This runner's threads: running ones first, then active, then ended, newest first within each. */
  threads: z.array(
    z.object({
      id: z.string(),
      botName: z.string(),
      subjects: z.array(z.string()),
      status: z.enum(["running", "active", "ended"]),
      waiting: z.number(),
      /** `limited` (waiting out a usage limit) and `interrupted` (cut off, resumes next delivery). */
      flags: z.array(z.string()),
      updatedAt: z.string(),
      bbThreadId: z.string().nullable(),
      bbThreadTitle: z.string().nullable(),
    }),
  ),
  /** Threads beyond the ones listed, so the page can say there are more. */
  moreThreads: z.number(),
  /** Threads of the same bots that other runners (like `loopway bots run`) own. */
  otherRunnerThreads: z.number(),
  /** Why the bots and threads couldn't be read just now, if they couldn't. */
  stateError: z.string().nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: snapshotSchema },
});

/** The realtime channel the page refetches on. */
export const STATE_CHANGED = "state-changed";

const MAX_THREADS = 200;

/** The runner's phase, which `changed` is told about (the server debounces it into a signal). */
export class RunnerStatus {
  phase: Phase = "starting";
  message: string | null = null;
  startedAt: number | null = null;
  lastTickAt: number | null = null;

  constructor(private readonly changed: () => void) {}

  set(phase: Phase, message: string | null = null): void {
    this.phase = phase;
    this.message = message;
    this.startedAt = phase === "running" ? Date.now() : phase === "starting" ? null : this.startedAt;
    this.changed();
  }

  /** Something the page shows may have changed: the runner logged a line (a run started or ended, say). */
  touch(): void {
    this.changed();
  }

  ticked(): void {
    this.lastTickAt = Date.now();
  }
}

/** What the runner is configured with, once it has started. */
export interface RunnerInfo {
  org: string;
  runnerId: string;
  projectId: string;
  interval: number;
  max: number;
}

/** The page's snapshot. `state` is the dispatcher's, when the runner is going and it could be read. */
export function buildSnapshot(input: {
  status: RunnerStatus;
  info?: RunnerInfo;
  state?: DispatcherState;
  stateError?: string;
  /** loopway thread id → bb thread id. */
  pairs: Map<string, string>;
  /** bb thread id → its title. */
  titles: Map<string, string | null>;
}): Snapshot {
  const { status, info, state, pairs, titles } = input;
  const bots = state?.bots ?? [];
  const names = new Map(bots.map((b) => [b.id, b.name]));
  const all = Object.values(state?.threads ?? {});
  const mine = all.filter((t) => t.runner_id === info?.runnerId);
  const rank = (s: string) => (s === "running" ? 0 : s === "active" ? 1 : 2);
  const threads = mine
    .map((t) => {
      const bbThreadId = pairs.get(t.id) ?? null;
      return {
        id: t.id,
        botName: names.get(t.bot_id) ?? "",
        subjects: t.subjects,
        status: state!.running.has(t.id) ? ("running" as const) : t.status,
        waiting: t.waiting.length,
        flags: [t.limited && "limited", t.interrupted && "interrupted"].filter((f): f is string => !!f),
        updatedAt: t.updated_at,
        bbThreadId,
        bbThreadTitle: bbThreadId ? (titles.get(bbThreadId) ?? null) : null,
      };
    })
    .sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt.localeCompare(a.updatedAt));
  return {
    runner: {
      phase: status.phase,
      message: status.message,
      org: info?.org ?? null,
      runnerId: info?.runnerId ?? null,
      projectId: info?.projectId ?? null,
      interval: info?.interval ?? null,
      max: info?.max ?? null,
      startedAt: status.startedAt,
      lastTickAt: status.lastTickAt,
    },
    bots: bots.map((b) => ({
      name: b.name,
      harness: b.harness,
      model: b.model,
    })),
    threads: threads.slice(0, MAX_THREADS),
    moreThreads: Math.max(0, threads.length - MAX_THREADS),
    otherRunnerThreads: all.length - mine.length,
    stateError: input.stateError ?? null,
  };
}
