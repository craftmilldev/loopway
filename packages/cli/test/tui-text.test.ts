import { describe, expect, it } from "vitest";
import { formatPollStatus, sessionText } from "../src/tui-text.js";
import { aThread } from "./make.js";

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

describe("a guarded thread", () => {
  it("says loop guard in place of its idle session, and keeps saying running while it runs", () => {
    const t = { ...aThread("t1", "dev", ["o/r#1"]), guarded: true as const };
    expect(sessionText(t)).toBe("loop guard");
    expect(sessionText({ ...t, session: { id: "s", status: "running", lastRunAt: null } })).toBe("running");
  });
});
