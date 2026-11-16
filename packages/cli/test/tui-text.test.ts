import { describe, expect, it } from "vitest";
import type { Thread } from "../src/thread.js";
import { formatPollStatus, groupThreads, threadState } from "../src/tui-text.js";
import { aThread, anUpdate } from "./make.js";

const NOW = new Date(2026, 10, 10, 14, 2, 30).getTime();
const poll = { lastCheckedAt: NOW - 6000, nextAt: NOW + 24_000, pausedUntil: 0, refreshing: false };

describe("formatPollStatus", () => {
  it("says what it watches, when it last checked and when it will next", () => {
    expect(formatPollStatus(["o/r", "o/s"], poll, NOW)).toBe("polling o/r, o/s · last checked 14:02 · next in 0:24");
  });

  it("says so before the first check", () => {
    expect(formatPollStatus(["o/r"], { ...poll, lastCheckedAt: undefined }, NOW)).toContain("last checked not yet");
  });

  it("counts minutes", () => {
    expect(formatPollStatus(["o/r"], { ...poll, nextAt: NOW + 95_000 }, NOW)).toContain("next in 1:35");
  });

  it("says refreshing… during a forced poll", () => {
    expect(formatPollStatus(["o/r"], { ...poll, refreshing: true }, NOW)).toBe("refreshing…");
  });

  it("says when GitHub has asked it to wait", () => {
    expect(formatPollStatus(["o/r"], { ...poll, pausedUntil: NOW + 90_000 }, NOW)).toBe(
      "rate limited · resumes in 1:30",
    );
  });
});

describe("groupThreads", () => {
  const t = (id: string, more: Partial<Thread> = {}) => ({ ...aThread(id, "dev", [`o/r#${id}`]), ...more });

  it("groups the open threads by state in order, then the closed, and leaves out empty groups", () => {
    const blocked = t("1", { session: { id: "s", status: "blocked", lastRunAt: null } });
    const idle = t("2", { session: { id: "s", status: "idle", lastRunAt: null } });
    const closed = t("3", { status: "closed" });
    const groups = groupThreads([closed, idle, blocked]);
    expect(groups.map((g) => [g.title, g.threads.map((x) => x.id)])).toEqual([
      ["Open · needs you", ["1"]],
      ["Open · quiet", ["2"]],
      ["Closed", ["3"]],
    ]);
  });

  it("says a thread with queued updates and no run in flight has updates waiting", () => {
    expect(threadState(t("1", { queue: [{ ...anUpdate("c"), subject: "o/r#1" }] }))).toBe("updates waiting");
  });
});
