import type { Bot, Thread } from "@loopway/cli/src/client.js";
import type { DispatcherState } from "@loopway/cli/src/bots/dispatcher.js";
import { describe, expect, it, vi } from "vitest";
import { buildSnapshot, RunnerStatus, type RunnerInfo } from "../status.js";

const bot = (id: string, name: string): Bot =>
  ({ id, name, harness: "claude", model: "opus", org_id: "org", prompt_version: null }) as unknown as Bot;

const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
  id,
  bot_id: "b1",
  created_by: "runner:r1",
  status: "active",
  started: true,
  interrupted: false,
  limited: false,
  runner_id: "r1",
  subjects: [`o/r#${id}`],
  waiting: [],
  inflight: [],
  delivered: 0,
  created_at: "2026-10-15T00:00:00Z",
  updated_at: "2026-10-15T00:00:00Z",
  ...overrides,
});

const info: RunnerInfo = { org: "craftmill", runnerId: "r1", projectId: "proj_1", interval: 5, max: 3 };

describe("buildSnapshot", () => {
  it("lists this runner's threads with their bb threads, running first", () => {
    const state: DispatcherState = {
      bots: [bot("b1", "reviewer"), bot("b2", "triager")],
      waiting: [],
      threads: {
        ended: thread("ended", { status: "ended", updated_at: "2026-10-15T03:00:00Z" }),
        old: thread("old", { updated_at: "2026-10-15T01:00:00Z" }),
        new: thread("new", {
          updated_at: "2026-10-15T02:00:00Z",
          limited: true,
          waiting: [{ id: "m1", inbox_id: "i", type: "t", subject: null }],
        }),
        busy: thread("busy"),
        theirs: thread("theirs", { runner_id: "cli-runner" }),
      },
      runnerId: "r1",
      runners: {},
      offline: new Set(),
      running: new Set(["busy"]),
    };
    const status = new RunnerStatus(() => {});
    status.set("running");
    const snap = buildSnapshot({
      status,
      info,
      state,
      pairs: new Map([["new", "thr_new"]]),
      titles: new Map([["thr_new", "reviewer: o/r#new"]]),
    });

    expect(snap.runner).toMatchObject({
      phase: "running",
      org: "craftmill",
      runnerId: "r1",
      interval: 5,
      max: 3,
    });
    expect(snap.bots).toEqual([
      { name: "reviewer", harness: "claude", model: "opus" },
      { name: "triager", harness: "claude", model: "opus" },
    ]);
    expect(snap.threads.map((t) => [t.id, t.status])).toEqual([
      ["busy", "running"],
      ["new", "active"],
      ["old", "active"],
      ["ended", "ended"],
    ]);
    expect(snap.threads[1]).toMatchObject({
      botName: "reviewer",
      waiting: 1,
      flags: ["limited"],
      bbThreadId: "thr_new",
      bbThreadTitle: "reviewer: o/r#new",
    });
    expect(snap.threads[2]).toMatchObject({ bbThreadId: null, bbThreadTitle: null });
    expect(snap.otherRunnerThreads).toBe(1);
    expect(snap.moreThreads).toBe(0);
  });

  it("says why when the runner isn't going", () => {
    const status = new RunnerStatus(() => {});
    status.set("needs-configuration", "Pick the bb project loopway threads start in.");
    const snap = buildSnapshot({ status, pairs: new Map(), titles: new Map() });
    expect(snap.runner).toMatchObject({
      phase: "needs-configuration",
      message: "Pick the bb project loopway threads start in.",
      org: null,
    });
    expect(snap.threads).toEqual([]);
  });
});

describe("RunnerStatus", () => {
  it("reports every change", () => {
    const changed = vi.fn();
    const status = new RunnerStatus(changed);
    status.set("running");
    status.touch();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("records when the runner started, and forgets it on a restart", () => {
    const status = new RunnerStatus(() => {});
    status.set("running");
    expect(status.startedAt).not.toBeNull();
    status.set("stopped", "Restarting with the new settings.");
    expect(status.startedAt).not.toBeNull();
    status.set("starting");
    expect(status.startedAt).toBeNull();
  });
});
