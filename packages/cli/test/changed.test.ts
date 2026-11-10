import { describe, expect, it } from "vitest";
import { GitHubSource } from "../src/github.js";
import { RateLimitError, type Subject } from "../src/source.js";
import { harness, rateLimited } from "./fake.js";

const subject = (n: number): Subject => ({
  key: `o/r#${n}`,
  kind: "issue",
  title: "A thing",
  author: "me",
  createdAt: "2026-11-10T12:30:00Z",
});

/** A fetch that answers the batched probe from `nodes` and the few REST calls a poll makes, counting probes. */
function probe(nodes: Record<string, unknown>, limited = false) {
  const queries: string[] = [];
  const rest: Record<string, unknown> = {
    "/repos/o/r/issues/7": {
      number: 7,
      title: "A thing",
      body: "",
      user: { login: "me" },
      created_at: "2026-11-10T12:30:00Z",
      updated_at: "2026-11-10T12:31:00Z",
    },
    "/repos/o/r/issues/7/events": [],
    "/repos/o/r/issues/7/comments": [],
  };
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.pathname === "/graphql") {
      if (limited) return new Response("", { status: 403, headers: { "retry-after": "5" } });
      queries.push((JSON.parse(init.body as string) as { query: string }).query);
      const data: Record<string, unknown> = {};
      for (const [alias, node] of Object.entries(nodes)) data[alias] = { issueOrPullRequest: node };
      return new Response(JSON.stringify({ data }));
    }
    const body = rest[url.pathname];
    return body === undefined ? new Response("", { status: 404 }) : new Response(JSON.stringify(body));
  }) as unknown as typeof globalThis.fetch;
  return { source: new GitHubSource({ token: "t", fetch }), queries };
}

describe("the batched probe", () => {
  const two = [subject(7), subject(8)];

  it("asks about every subject in one request", async () => {
    const { source, queries } = probe({ s0: { updatedAt: "a" }, s1: { updatedAt: "b" } });
    expect((await source.changed(two)).size).toBe(2); // never polled, so all changed
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("number: 7");
    expect(queries[0]).toContain("number: 8");
  });

  it("reports only subjects that moved since they were polled, and CI counts", async () => {
    const nodes: Record<string, unknown> = { s0: { updatedAt: "a" }, s1: { updatedAt: "b" } };
    const { source } = probe(nodes);
    await source.changed(two);
    await source.poll(subject(7)); // takes in #7 only
    expect([...(await source.changed(two))]).toEqual(["o/r#8"]);
    nodes.s0 = { updatedAt: "a", checks: "now failing" };
    expect([...(await source.changed(two))]).toEqual(["o/r#7", "o/r#8"]);
  });

  it("calls a subject it cannot read changed, so the poll can say why", async () => {
    const { source } = probe({ s0: null, s1: { updatedAt: "b" } });
    expect([...(await source.changed(two))]).toContain("o/r#7");
  });

  it("sends 50 subjects to a request", async () => {
    const { source, queries } = probe({});
    await source.changed(Array.from({ length: 120 }, (_, i) => subject(i + 1)));
    expect(queries).toHaveLength(3);
  });

  it("surfaces a rate limit", async () => {
    const { source } = probe({}, true);
    expect(await source.changed(two).catch((e: unknown) => e)).toBeInstanceOf(RateLimitError);
  });
});

describe("the poller with a probe", () => {
  async function two() {
    const h = harness();
    await h.poller.discover();
    h.source.add("o/r#1", "me", "2026-11-10T12:01:00Z");
    h.source.add("o/r#2", "me", "2026-11-10T12:02:00Z");
    await h.poller.discover();
    h.source.calls.length = 0;
    return h;
  }

  it("polls only the subjects the source says changed", async () => {
    const h = await two();
    h.source.changed = async () => new Set(["o/r#2"]);
    await h.poller.updates();
    expect(h.source.calls).toEqual(["poll o/r#2"]);
  });

  it("polls everything if the probe fails", async () => {
    const h = await two();
    h.source.changed = async () => {
      throw new Error("graphql down");
    };
    await h.poller.updates();
    expect(h.source.calls).toEqual(["poll o/r#1", "poll o/r#2"]);
    expect(h.logs).toEqual(["checking for changes: graphql down"]);
  });

  it("lets a rate limit from the probe pause everything", async () => {
    const h = await two();
    h.source.changed = async () => {
      throw rateLimited(h.clock.t + 1000);
    };
    await expect(h.poller.updates()).rejects.toThrow("rate limited");
    expect(h.source.calls).toEqual([]);
  });
});
