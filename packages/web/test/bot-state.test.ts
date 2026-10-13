import { describe, expect, it } from "vitest";
import { botState, filterOf, stateReason, type BotState } from "../client/bot-state.js";

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

describe("filterOf", () => {
  it("groups states into the filter tabs", () => {
    const states: BotState[] = ["stranded", "limited", "working", "waiting", "idle"];
    expect(states.map(filterOf)).toEqual(["stopped", "stopped", "working", "working", "idle"]);
  });
});
