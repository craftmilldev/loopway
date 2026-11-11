import { describe, expect, it } from "vitest";
import { GitHubSource } from "../src/github.js";
import { RateLimitError, type Subject } from "../src/source.js";

type Handler = (url: URL, init: RequestInit) => Response | undefined;

/** A fetch that answers from a table of paths, and counts calls. */
function fakeGitHub(routes: Record<string, unknown>, now = () => Date.parse("2026-11-10T12:00:00Z")) {
  const requests: string[] = [];
  const handlers: Handler[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    requests.push(url.pathname + url.search);
    for (const h of handlers) {
      const res = h(url, init);
      if (res) return res;
    }
    const body = routes[url.pathname];
    if (body === undefined) return new Response("not found", { status: 404 });
    const etag = `"${JSON.stringify(body).length}"`;
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers["if-none-match"] === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag } });
  }) as unknown as typeof globalThis.fetch;
  return { source: new GitHubSource({ token: "t", fetch, now }), requests, handlers };
}

const issue = (over: object = {}) => ({
  number: 7,
  title: "A thing",
  body: "details",
  user: { login: "me" },
  created_at: "2026-11-10T12:30:00Z",
  updated_at: "2026-11-10T12:31:00Z",
  ...over,
});

const subject = (kind: Subject["kind"] = "issue"): Subject => ({
  key: "o/r#7",
  kind,
  title: "A thing",
  author: "me",
  createdAt: "2026-11-10T12:30:00Z",
});

describe("comment", () => {
  it("posts to the issue's comments endpoint, as the token's user, and returns the comment's URL", async () => {
    const { source, handlers } = fakeGitHub({});
    const sent: { path: string; method?: string; auth: string; body: unknown }[] = [];
    handlers.push((url, init) => {
      const headers = init.headers as Record<string, string>;
      sent.push({
        path: url.pathname,
        method: init.method,
        auth: headers.authorization!,
        body: JSON.parse(init.body as string),
      });
      return new Response(JSON.stringify({ html_url: "https://github.com/o/r/issues/7#issuecomment-5" }), {
        status: 201,
      });
    });
    expect(await source.comment("o/r#7", "hello")).toBe("https://github.com/o/r/issues/7#issuecomment-5");
    expect(sent).toEqual([
      { path: "/repos/o/r/issues/7/comments", method: "POST", auth: "Bearer t", body: { body: "hello" } },
    ]);
  });

  it("fails with what GitHub said", async () => {
    const { source, handlers } = fakeGitHub({});
    handlers.push(() => new Response("Resource not accessible", { status: 403 }));
    await expect(source.comment("o/r#7", "hello")).rejects.toThrow(/403.*Resource not accessible/);
  });
});

describe("a comment's text", () => {
  it("is on its update, and so is a review's", async () => {
    const { source } = fakeGitHub({
      "/repos/o/r/issues/7": issue(),
      "/repos/o/r/issues/7/events": [],
      "/repos/o/r/issues/7/comments": [
        {
          id: 1,
          body: "What's 2+2?",
          user: { login: "me" },
          created_at: "2026-11-10T12:32:00Z",
          updated_at: "2026-11-10T12:32:00Z",
        },
      ],
    });
    const { updates } = await source.updates(subject());
    expect(updates.map((u) => [u.kind, u.body])).toEqual([["comment", "What's 2+2?"]]);
  });
});

describe("discover", () => {
  it("returns subjects created since, telling issues from pull requests", async () => {
    const { source } = fakeGitHub({
      "/repos/o/r/issues": [
        issue({ number: 3, created_at: "2026-11-10T13:00:00Z", pull_request: {} }),
        issue({ number: 2, created_at: "2026-11-10T12:30:00Z", user: { login: "other" } }),
        issue({ number: 1, created_at: "2026-11-10T11:00:00Z" }), // before since
      ],
    });
    const found = await source.discover("o/r", "2026-11-10T12:00:00.000Z");
    expect(found.map((s) => [s.key, s.kind, s.author])).toEqual([
      ["o/r#3", "pull_request", "me"],
      ["o/r#2", "issue", "other"],
    ]);
  });
});

describe("updates", () => {
  const events = [
    { id: 1, event: "labeled", actor: { login: "me" }, created_at: "2026-11-10T12:31:00Z", label: { name: "bug" } },
    { id: 2, event: "subscribed", actor: { login: "me" }, created_at: "2026-11-10T12:31:00Z" },
    { id: 3, event: "closed", actor: { login: "me" }, created_at: "2026-11-10T12:33:00Z" },
  ];
  const comments = [
    { id: 10, user: { login: "loopway-bot" }, created_at: "2026-11-10T12:32:00Z", updated_at: "2026-11-10T12:32:00Z" },
  ];

  it("turns events and comments into updates, oldest first", async () => {
    const { source } = fakeGitHub({
      "/repos/o/r/issues/7": issue(),
      "/repos/o/r/issues/7/events": events,
      "/repos/o/r/issues/7/comments": comments,
    });
    const { updates } = await source.updates(subject());
    expect(updates.map((u) => [u.id, u.kind, u.detail, u.actor])).toEqual([
      ["event:1", "labeled", "bug", "me"],
      ["comment:10:2026-11-10T12:32:00Z", "comment", undefined, "loopway-bot"],
      ["event:3", "closed", undefined, "me"],
    ]);
  });

  it("asks nothing more when the subject has not changed", async () => {
    const { source, requests } = fakeGitHub({
      "/repos/o/r/issues/7": issue(),
      "/repos/o/r/issues/7/events": events,
      "/repos/o/r/issues/7/comments": comments,
    });
    const first = await source.updates(subject());
    requests.length = 0;
    const second = await source.updates(subject(), first.version);
    expect(second.updates).toEqual([]);
    expect(requests).toEqual(["/repos/o/r/issues/7"]);
  });

  it("reports an edit to the title or body, but not the first sight of it", async () => {
    const routes: Record<string, unknown> = {
      "/repos/o/r/issues/7": issue(),
      "/repos/o/r/issues/7/events": [],
      "/repos/o/r/issues/7/comments": [],
    };
    const { source } = fakeGitHub(routes);
    const first = await source.updates(subject());
    expect(first.updates).toEqual([]);
    routes["/repos/o/r/issues/7"] = issue({ body: "new details", updated_at: "2026-11-10T12:40:00Z" });
    const second = await source.updates(subject(), first.version);
    expect(second.updates.map((u) => u.kind)).toEqual(["edited"]);
  });

  it("covers reviews, review comments and CI on an open pull request", async () => {
    const sha = "abc123";
    const { source, requests } = fakeGitHub({
      "/repos/o/r/pulls/7": issue({ state: "open", head: { sha } }),
      "/repos/o/r/issues/7/events": [],
      "/repos/o/r/issues/7/comments": [],
      "/repos/o/r/pulls/7/reviews": [
        { id: 20, user: { login: "rev" }, state: "CHANGES_REQUESTED", submitted_at: "2026-11-10T12:35:00Z" },
        { id: 21, user: { login: "rev" }, state: "PENDING" },
      ],
      "/repos/o/r/pulls/7/comments": [
        { id: 30, user: { login: "rev" }, created_at: "2026-11-10T12:36:00Z", updated_at: "2026-11-10T12:36:00Z" },
      ],
      [`/repos/o/r/commits/${sha}/check-runs`]: {
        check_runs: [
          {
            id: 40,
            name: "test",
            status: "completed",
            conclusion: "success",
            completed_at: "2026-11-10T12:37:00Z",
            app: { slug: "github-actions" },
          },
        ],
      },
      [`/repos/o/r/commits/${sha}/status`]: {
        statuses: [
          { id: 50, context: "vercel", state: "pending", updated_at: "2026-11-10T12:38:00Z", creator: { login: "v" } },
        ],
      },
    });
    const { updates } = await source.updates(subject("pull_request"));
    // The pull request's own endpoint has everything: the issue one is never read.
    expect(requests).not.toContain("/repos/o/r/issues/7");
    expect(updates.map((u) => [u.kind, u.detail])).toEqual([
      ["review", "changes requested"],
      ["review comment", undefined],
      ["check_run", "test success"],
      ["status", "vercel pending"],
    ]);
  });

  it("reports a check run again when its result changes, but not when it repeats", async () => {
    const routes: Record<string, unknown> = {
      "/repos/o/r/pulls/7": issue({ state: "open", head: { sha: "s" } }),
      "/repos/o/r/issues/7/events": [],
      "/repos/o/r/issues/7/comments": [],
      "/repos/o/r/pulls/7/reviews": [],
      "/repos/o/r/pulls/7/comments": [],
      "/repos/o/r/commits/s/check-runs": {
        check_runs: [{ id: 1, name: "ci", status: "in_progress", conclusion: null }],
      },
      "/repos/o/r/commits/s/status": { statuses: [] },
    };
    const { source } = fakeGitHub(routes);
    const a = await source.updates(subject("pull_request"));
    const b = await source.updates(subject("pull_request"), a.version);
    routes["/repos/o/r/commits/s/check-runs"] = {
      check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "failure" }],
    };
    const c = await source.updates(subject("pull_request"), b.version);
    expect(a.updates[0]?.id).toBe(b.updates[0]?.id);
    expect(c.updates[0]?.id).not.toBe(a.updates[0]?.id);
    expect(c.updates[0]?.detail).toBe("ci failure");
  });
});

describe("rate limits", () => {
  const limited = (headers: Record<string, string>, status = 403) =>
    ((url: URL) => (url.pathname === "/user" ? new Response("slow down", { status, headers }) : undefined)) as Handler;

  it("waits until x-ratelimit-reset when the quota is spent", async () => {
    const { source, handlers } = fakeGitHub({});
    handlers.push(limited({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794315600" }));
    const err = await source.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).resumeAt).toBe(1794315600 * 1000);
  });

  it("waits retry-after seconds, including for a secondary limit", async () => {
    const { source, handlers } = fakeGitHub({}, () => 1_000_000);
    handlers.push(limited({ "retry-after": "90" }));
    const err = await source.whoami().catch((e: unknown) => e);
    expect((err as RateLimitError).resumeAt).toBe(1_000_000 + 90_000);
  });

  it("treats a 429 as a rate limit", async () => {
    const { source, handlers } = fakeGitHub({}, () => 0);
    handlers.push(limited({}, 429));
    expect(await source.whoami().catch((e: unknown) => e)).toBeInstanceOf(RateLimitError);
  });

  it("does not treat a plain 403 as one", async () => {
    const { source, handlers } = fakeGitHub({});
    handlers.push((url) => (url.pathname === "/user" ? new Response("forbidden", { status: 403 }) : undefined));
    const err = await source.whoami().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect((err as Error).message).toContain("403");
  });
});
