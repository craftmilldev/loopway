import { describe, expect, it } from "vitest";
import { Poller, UPDATE_EVERY_MS } from "../src/poller.js";
import { emptyState } from "../src/state.js";
import { FakeSource, harness, rateLimited } from "./fake.js";

describe("discovery", () => {
  it("reports a new issue by you, and one by the bot", async () => {
    const h = harness();
    await h.poller.discover(); // the first run starts now
    h.source.add("o/r#1", "me", "2026-11-10T12:01:00Z");
    h.source.add("o/r#2", "loopway-bot", "2026-11-10T12:02:00Z", "pull_request");
    await h.poller.discover();
    expect(h.events.map((e) => e.type === "new" && e.subject.key)).toEqual(["o/r#1", "o/r#2"]);
  });

  it("ignores subjects by anyone else", async () => {
    const h = harness();
    await h.poller.discover();
    h.source.add("o/r#1", "someone-else", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    expect(h.events).toEqual([]);
    expect(h.state.subjects).toEqual({});
  });

  it("matches authors regardless of case", async () => {
    const h = harness({ authors: ["Me"] });
    await h.poller.discover();
    h.source.add("o/r#1", "ME", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    expect(h.events).toHaveLength(1);
  });

  it("does not replay history on the first run", async () => {
    const h = harness();
    h.source.add("o/r#1", "me", "2026-11-09T09:00:00Z"); // before loopway started
    await h.poller.discover();
    expect(h.events).toEqual([]);
    expect(h.state.repos["o/r"]?.since).toBe("2026-11-10T12:00:00.000Z");
  });

  it("reports a subject once, however many times discovery sees it", async () => {
    const h = harness();
    await h.poller.discover();
    h.source.add("o/r#1", "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    await h.poller.discover();
    expect(h.events).toHaveLength(1);
  });

  it("covers every repo", async () => {
    const h = harness({ repos: ["o/a", "o/b"] });
    await h.poller.discover();
    h.source.add("o/b#4", "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    expect(h.source.calls).toContain("discover o/a");
    expect(h.events).toHaveLength(1);
  });
});

describe("updates", () => {
  async function withIssue() {
    const h = harness();
    await h.poller.discover();
    h.source.add("o/r#1", "me", "2026-11-10T12:01:00Z");
    await h.poller.discover();
    h.events.length = 0;
    return h;
  }

  it("reports each update on a known subject once", async () => {
    const h = await withIssue();
    h.source.say("o/r#1", { id: "comment:1", actor: "loopway-bot" });
    h.source.say("o/r#1", { id: "event:2", kind: "labeled", detail: "bug" });
    await h.poller.updates();
    await h.poller.updates();
    expect(h.events.map((e) => e.type === "update" && e.update.id)).toEqual(["comment:1", "event:2"]);
    h.source.say("o/r#1", { id: "event:3", kind: "closed" });
    await h.poller.updates();
    expect(h.events).toHaveLength(3);
  });

  it("says nothing about subjects it has not discovered", async () => {
    const h = await withIssue();
    h.source.say("o/r#99", { id: "comment:1" });
    await h.poller.updates();
    expect(h.events).toEqual([]);
    expect(h.source.calls).not.toContain("updates o/r#99");
  });

  it("logs a subject that fails and goes on to the next", async () => {
    const h = harness();
    await h.poller.discover();
    h.source.add("o/r#1", "me", "2026-11-10T12:01:00Z");
    h.source.add("o/r#2", "me", "2026-11-10T12:02:00Z");
    await h.poller.discover();
    h.events.length = 0;
    const ask = h.source.updates.bind(h.source);
    h.source.updates = async (s) => {
      if (s.key === "o/r#1") throw new Error("404");
      return ask(s);
    };
    h.source.say("o/r#2", { id: "comment:1" });
    await h.poller.updates();
    expect(h.logs).toEqual(["o/r#1: 404"]);
    expect(h.events).toHaveLength(1);
  });
});

describe("restarts", () => {
  it("prints nothing twice when started again on the saved state", async () => {
    const first = harness();
    await first.poller.discover();
    first.source.add("o/r#1", "me", "2026-11-10T12:01:00Z");
    first.source.say("o/r#1", { id: "comment:1" });
    await first.poller.discover();
    await first.poller.updates();
    expect(first.events).toHaveLength(2);

    // A new process: new poller and source, the state read back from disk.
    const second = harness({ state: JSON.parse(first.saved.at(-1)!) });
    second.source.subjects = first.source.subjects;
    second.source.said = first.source.said;
    await second.poller.discover();
    await second.poller.updates();
    expect(second.events).toEqual([]);

    second.source.say("o/r#1", { id: "comment:2" });
    await second.poller.updates();
    expect(second.events).toHaveLength(1);
  });

  it("finds what was created while it was stopped", async () => {
    const first = harness();
    await first.poller.discover();
    const second = harness({ state: JSON.parse(first.saved.at(-1)!), start: "2026-11-10T18:00:00Z" });
    second.source.add("o/r#5", "me", "2026-11-10T15:00:00Z");
    await second.poller.discover();
    expect(second.events).toHaveLength(1);
  });
});

describe("rate limits", () => {
  it("waits until the reset time, then carries on", async () => {
    const h = harness();
    const stop = new AbortController();
    const sleeps: number[] = [];
    const resetAt = h.clock.t + 10 * 60_000;
    h.source.failWith = rateLimited(resetAt);
    let rounds = 0;
    await h.poller.run(stop.signal, async (ms) => {
      sleeps.push(ms);
      h.clock.t += ms;
      if (++rounds === 1) h.source.failWith = undefined; // the limit lifts at the reset time
      if (rounds === 3) stop.abort();
    });
    // The first sleep is the whole wait, not the 30 seconds the update interval would give.
    expect(sleeps[0]).toBe(10 * 60_000);
    expect(h.logs[0]).toBe("rate limited: waiting 600s");
    // After the pause it polls again and goes back to the normal pace.
    expect(h.source.calls.filter((c) => c.startsWith("discover")).length).toBe(2);
    expect(sleeps[1]).toBe(UPDATE_EVERY_MS);
  });

  it("makes no requests while paused", async () => {
    const h = harness();
    h.source.failWith = rateLimited(h.clock.t + 5 * 60_000);
    const stop = new AbortController();
    let rounds = 0;
    await h.poller.run(stop.signal, async () => {
      // never moves the clock, so the pause never ends
      if (++rounds === 4) stop.abort();
    });
    expect(h.source.calls).toEqual(["discover o/r"]);
  });

  it("discovers every two minutes and polls every thirty seconds", async () => {
    const h = harness();
    const stop = new AbortController();
    const start = h.clock.t;
    let rounds = 0;
    await h.poller.run(stop.signal, async (ms) => {
      h.clock.t += ms;
      if (++rounds === 8) stop.abort();
    });
    // Eight passes, 30 seconds apart: t = 0 ... 210s. Discovery ran at 0 and at 120s.
    expect(h.clock.t - start).toBe(8 * UPDATE_EVERY_MS);
    expect(h.source.calls.filter((c) => c.startsWith("discover")).length).toBe(2);
  });
});

describe("status", () => {
  it("tells when it last checked and when it will next, and when it is refreshing", async () => {
    const h = harness();
    expect(h.poller.status()).toMatchObject({ lastCheckedAt: undefined, refreshing: false });
    const first = h.poller.refresh();
    expect(h.poller.status().refreshing).toBe(true);
    await first;
    expect(h.poller.status()).toEqual({
      lastCheckedAt: h.clock.t,
      nextAt: h.clock.t + UPDATE_EVERY_MS,
      pausedUntil: 0,
      refreshing: false,
    });
  });
});

describe("refresh", () => {
  it("polls now, and restarts the timers from that moment", async () => {
    const h = harness();
    h.state.subjects["o/r#1"] = {
      subject: { key: "o/r#1", kind: "issue", title: "t", author: "me", createdAt: "2026-11-10T11:00:00Z" },
      seen: [],
    };
    await h.poller.refresh();
    expect(h.source.calls).toEqual(["discover o/r", "updates o/r#1"]);
    const stop = new AbortController();
    const sleeps: number[] = [];
    await h.poller.run(stop.signal, async (ms) => {
      sleeps.push(ms);
      stop.abort();
    });
    // Nothing was due, so run polled nothing and waits the full update interval.
    expect(h.source.calls.length).toBe(2);
    expect(sleeps).toEqual([UPDATE_EVERY_MS]);
  });

  it("says so in the log and calls nothing while GitHub has asked us to wait", async () => {
    const h = harness();
    h.source.failWith = rateLimited(h.clock.t + 90_000);
    await h.poller.refresh();
    h.source.failWith = undefined;
    await h.poller.refresh();
    expect(h.logs).toEqual(["rate limited: waiting 90s", "rate limited: waiting 90s"]);
    expect(h.source.calls).toEqual(["discover o/r"]);
  });
});

it("a poller with no repos does nothing", async () => {
  const events: unknown[] = [];
  const poller = new Poller({
    source: new FakeSource(),
    state: emptyState(),
    save: async () => {},
    repos: [],
    authors: ["me"],
    emit: (e) => void events.push(e),
  });
  await poller.discover();
  await poller.updates();
  expect(events).toEqual([]);
});
