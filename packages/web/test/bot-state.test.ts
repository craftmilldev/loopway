import { describe, expect, it } from "vitest";
import { botState, countThreads, filterOf, stateReason, sumCounts, type BotState } from "../client/bot-state.js";

const runners = [
  { id: "on", leased_until: "2030-01-01T00:00:00Z" },
  { id: "off", leased_until: null },
];
const thread = (o: Partial<Parameters<typeof botState>[0][number]> = {}) => ({
  status: "active" as const,
  runner_id: null,
  limited: false,
  inflight: [],
  ...o,
});
const inflight = [{ id: "m", inbox_id: "i", type: "t", subject: null, summary: null }];

describe("botState", () => {
  it("is idle with no active threads", () => {
    expect(botState([], runners)).toBe("idle");
    expect(botState([thread({ status: "ended", limited: true, runner_id: "off" })], runners)).toBe("idle");
  });
  it("is waiting when threads are active and nothing is inflight", () => {
    expect(botState([thread(), thread({ runner_id: "on" })], runners)).toBe("waiting");
  });
  it("is working when a thread has inflight messages", () => {
    expect(botState([thread(), thread({ inflight })], runners)).toBe("working");
  });
  it("is limited when an active thread is limited", () => {
    expect(botState([thread({ limited: true })], runners)).toBe("limited");
  });
  it("is stranded when an active thread's runner has no lease", () => {
    expect(botState([thread({ runner_id: "off" })], runners)).toBe("stranded");
  });
  it("checks stranded, then limited, then working", () => {
    expect(botState([thread({ runner_id: "off", limited: true, inflight })], runners)).toBe("stranded");
    expect(botState([thread({ limited: true, inflight })], runners)).toBe("limited");
    expect(botState([thread({ inflight })], runners)).toBe("working");
  });
});

describe("stateReason", () => {
  const t = (n: number) => ({ status: "active" as const, inflight: Array(n).fill(inflight[0]!) });
  it("says why for each state, and nothing for idle", () => {
    expect(stateReason("stranded", [])).toBe("Its runner is offline");
    expect(stateReason("limited", [])).toBe("Hit its usage limit");
    expect(stateReason("waiting", [t(0)])).toBe("Waiting for a runner");
    expect(stateReason("working", [t(1)])).toBe("1 message in flight");
    expect(stateReason("working", [t(2), t(1)])).toBe("3 messages in flight");
    expect(stateReason("idle", [])).toBe("");
  });
});

describe("countThreads and sumCounts", () => {
  const msg = inflight[0]!;
  const t = (nInflight: number, nWaiting: number) => ({
    inflight: Array(nInflight).fill(msg),
    waiting: Array(nWaiting).fill(msg),
  });
  it("counts nothing for no threads", () => {
    expect(countThreads([])).toEqual({ open: 0, working: 0, quiet: 0, waiting: 0 });
    expect(sumCounts([])).toEqual({ open: 0, working: 0, quiet: 0, waiting: 0 });
  });
  it("counts a thread with nothing inflight or queued as quiet", () => {
    expect(countThreads([t(0, 0), t(0, 0)])).toEqual({ open: 2, working: 0, quiet: 2, waiting: 0 });
  });
  it("counts threads with inflight messages as working", () => {
    expect(countThreads([t(2, 0), t(1, 0), t(0, 0)])).toEqual({ open: 3, working: 2, quiet: 1, waiting: 0 });
  });
  it("counts queued messages, not threads, as waiting", () => {
    expect(countThreads([t(0, 3), t(1, 2), t(0, 0)])).toEqual({ open: 3, working: 1, quiet: 2, waiting: 5 });
  });
  it("adds several bots up, with working and quiet adding to open", () => {
    const sum = sumCounts([countThreads([t(1, 1), t(0, 4)]), countThreads([]), countThreads([t(0, 0), t(3, 2)])]);
    expect(sum).toEqual({ open: 4, working: 2, quiet: 2, waiting: 7 });
    expect(sum.working + sum.quiet).toBe(sum.open);
  });
});

describe("filterOf", () => {
  it("groups states into the filter tabs", () => {
    const states: BotState[] = ["stranded", "limited", "working", "waiting", "idle"];
    expect(states.map(filterOf)).toEqual(["stopped", "stopped", "working", "working", "idle"]);
  });
});
