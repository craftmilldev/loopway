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
  state: "open",
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

describe("reactions", () => {
  it("reads who reacted how from a comment's URL, on an issue or a pull request", async () => {
    const { source, requests } = fakeGitHub({
      "/repos/o/r/issues/comments/55/reactions": [
        { content: "+1", user: { login: "me" } },
        { content: "heart", user: { login: "other" } },
      ],
    });
    const expected = [
      { content: "+1", user: "me" },
      { content: "heart", user: "other" },
    ];
    expect(await source.reactions("https://github.com/o/r/issues/7#issuecomment-55")).toEqual(expected);
    expect(await source.reactions("https://github.com/o/r/pull/8#issuecomment-55")).toEqual(expected);
    expect(requests[0]).toContain("/repos/o/r/issues/comments/55/reactions");
    await expect(source.reactions("https://example.com/x")).rejects.toThrow("not a comment URL");
  });
});

describe("opening an issue or a pull request", () => {
  const sentTo = (answer: object) => {
    const { source, handlers } = fakeGitHub({});
    const sent: { path: string; method?: string; body: unknown }[] = [];
    handlers.push((url, init) => {
      sent.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(answer), { status: 201 });
    });
    return { source, sent };
  };
  const made = (over: object = {}) => ({
    number: 9,
    title: "Follow up",
    body: "Do it.",
    user: { login: "loopway-bot" },
    created_at: "2026-11-10T13:00:00Z",
    updated_at: "2026-11-10T13:00:00Z",
    html_url: "https://github.com/o/r/issues/9",
    ...over,
  });

  it("posts an issue to the repo's issues endpoint and returns the subject GitHub made, with its URL", async () => {
    const { source, sent } = sentTo(made());
    expect(await source.createIssue("o/r", "Follow up", "Do it.")).toEqual({
      url: "https://github.com/o/r/issues/9",
      subject: {
        key: "o/r#9",
        kind: "issue",
        title: "Follow up",
        author: "loopway-bot",
        createdAt: "2026-11-10T13:00:00Z",
        assignees: [],
        labels: [],
        body: "Do it.",
      },
    });
    expect(sent).toEqual([{ path: "/repos/o/r/issues", method: "POST", body: { title: "Follow up", body: "Do it." } }]);
  });

  it("assigns the issue when asked, and reads the assignees GitHub echoes back", async () => {
    const { source, sent } = sentTo(made({ assignees: [{ login: "mcwhittemore" }] }));
    const issue = await source.createIssue("o/r", "Do it", "Now.", ["mcwhittemore"]);
    expect(issue.subject.assignees).toEqual(["mcwhittemore"]);
    expect(sent[0]?.body).toEqual({ title: "Do it", body: "Now.", assignees: ["mcwhittemore"] });
  });

  it("posts a pull request from its branch to the repo's pulls endpoint", async () => {
    const { source, sent } = sentTo(made({ html_url: "https://github.com/o/r/pull/9" }));
    const pr = await source.createPr("o/r", "fix-it", "main", "Fix it", "The fix.");
    expect(pr).toMatchObject({ url: "https://github.com/o/r/pull/9", subject: { key: "o/r#9", kind: "pull_request" } });
    expect(sent).toEqual([
      {
        path: "/repos/o/r/pulls",
        method: "POST",
        body: { head: "fix-it", base: "main", title: "Fix it", body: "The fix." },
      },
    ]);
  });

  it("fails with what GitHub said", async () => {
    const { source, handlers } = fakeGitHub({});
    handlers.push(() => new Response("Validation Failed", { status: 422 }));
    await expect(source.createPr("o/r", "fix-it", "main", "Fix it", "")).rejects.toThrow(/422.*Validation Failed/);
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
  it("returns subjects created or touched since, telling issues from pull requests", async () => {
    const { source } = fakeGitHub({
      "/repos/o/r/issues": [
        issue({ number: 3, created_at: "2026-11-10T13:00:00Z", pull_request: {} }),
        issue({ number: 2, created_at: "2026-11-10T12:30:00Z", user: { login: "other" } }),
        issue({ number: 0, created_at: "2026-11-09T11:00:00Z" }), // old, but touched after since
        issue({ number: 1, created_at: "2026-11-10T11:00:00Z", updated_at: "2026-11-10T11:30:00Z" }), // untouched
      ],
    });
    const found = await source.discover("o/r", "2026-11-10T12:00:00.000Z");
    expect(found.map((s) => [s.key, s.kind, s.author])).toEqual([
      ["o/r#3", "pull_request", "me"],
      ["o/r#2", "issue", "other"],
      ["o/r#0", "issue", "me"],
    ]);
  });

  it("asks only for what was active since, most recently active first", async () => {
    const { source, requests } = fakeGitHub({ "/repos/o/r/issues": [] });
    await source.discover("o/r", "2026-11-10T12:00:00.000Z");
    expect(requests[0]).toContain("sort=updated&direction=desc");
    expect(requests[0]).toContain("since=2026-11-10T12%3A00%3A00.000Z");
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
    ]);
  });

  describe("CI", () => {
    const pr = (checks: unknown[], statuses: unknown[] = [], sha = "s") => ({
      "/repos/o/r/pulls/7": issue({ state: "open", head: { sha } }),
      "/repos/o/r/issues/7/events": [],
      "/repos/o/r/issues/7/comments": [],
      "/repos/o/r/pulls/7/reviews": [],
      "/repos/o/r/pulls/7/comments": [],
      [`/repos/o/r/commits/${sha}/check-runs`]: { check_runs: checks },
      [`/repos/o/r/commits/${sha}/status`]: { statuses },
    });
    const run = (id: number, status: string, conclusion: string | null, name = `job${id}`) => ({
      id,
      name,
      status,
      conclusion,
      completed_at: status === "completed" ? `2026-11-10T12:4${id}:00Z` : undefined,
    });
    const ci = async (routes: Record<string, unknown>) => {
      const { source } = fakeGitHub(routes);
      return (await source.updates(subject("pull_request"))).updates.map((u) => [u.kind, u.detail]);
    };

    it("wakes for a check that finished failing, for every failing conclusion", async () => {
      for (const conclusion of ["failure", "timed_out", "cancelled", "action_required"])
        expect(await ci(pr([run(1, "completed", conclusion, "test"), run(2, "in_progress", null)]))).toEqual([
          ["check_run", `test ${conclusion}`],
        ]);
    });

    it("says nothing for checks in progress, passing, skipped or neutral while another is still running", async () => {
      const checks = [run(1, "completed", "success"), run(2, "completed", "skipped"), run(3, "in_progress", null)];
      expect(
        await ci(pr(checks, [{ id: 9, context: "v", state: "pending", updated_at: "2026-11-10T12:40:00Z" }])),
      ).toEqual([]);
    });

    it("sends one summary once every check and status has finished", async () => {
      const checks = [
        run(1, "completed", "success"),
        run(2, "completed", "failure", "lint"),
        run(3, "completed", "neutral"),
      ];
      const statuses = [{ id: 9, context: "v", state: "success", updated_at: "2026-11-10T12:45:00Z" }];
      expect(await ci(pr(checks, statuses))).toEqual([
        ["check_run", "lint failure"],
        ["ci_finished", "CI finished: 3 passed, 1 failed"],
      ]);
    });

    it("sends a failing status when it fails, and holds the summary while a status is pending", async () => {
      const statuses = [{ id: 9, context: "v", state: "error", updated_at: "2026-11-10T12:45:00Z" }];
      expect(await ci(pr([run(1, "in_progress", null)], statuses))).toEqual([["status", "v error"]]);
    });

    it("sends nothing for a commit with no checks yet", async () => {
      expect(await ci(pr([]))).toEqual([]);
    });

    it("reports each result once, and starts over for a new head commit", async () => {
      const routes = pr([run(1, "in_progress", null), run(2, "completed", "failure")]);
      const { source } = fakeGitHub(routes);
      const a = await source.updates(subject("pull_request"));
      const b = await source.updates(subject("pull_request"), a.version);
      expect(b.updates.map((u) => u.id)).toEqual(a.updates.map((u) => u.id));
      Object.assign(routes, pr([run(1, "completed", "success"), run(2, "completed", "failure")]));
      const c = await source.updates(subject("pull_request"), b.version);
      expect(c.updates.map((u) => u.kind)).toEqual(["check_run", "ci_finished"]);
      // A push (a longer sha, since the fake's etag is the body's length): the new commit's checks have new ids, and its summary is its own.
      Object.assign(routes, pr([run(3, "completed", "success")], [], "new-head"));
      (routes["/repos/o/r/pulls/7"] as unknown as { head: { sha: string } }).head.sha = "new-head";
      const d = await source.updates(subject("pull_request"), c.version);
      expect(d.updates.map((u) => [u.kind, u.detail])).toEqual([["ci_finished", "CI finished: 1 passed, 0 failed"]]);
      expect(c.updates.map((u) => u.id)).not.toContain(d.updates[0]?.id);
    });
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

describe("assignees and teams", () => {
  it("discover reads who each issue is assigned to", async () => {
    const { source } = fakeGitHub({
      "/repos/o/r/issues": [issue({ assignees: [{ login: "me" }, { login: "alice" }] }), issue({ number: 8 })],
    });
    const found = await source.discover("o/r", "2026-11-10T12:00:00Z");
    expect(found.map((s) => s.assignees)).toEqual([["me", "alice"], []]);
  });

  it("reads each issue's label names, from discovery and from a created issue", async () => {
    const { source } = fakeGitHub({
      "/repos/o/r/issues": [issue({ labels: [{ name: "epic" }, { name: "bug" }] }), issue({ number: 8 })],
    });
    const found = await source.discover("o/r", "2026-11-10T12:00:00Z");
    expect(found.map((s) => s.labels)).toEqual([["epic", "bug"], []]);
  });

  it("teamMembers lists a team's logins, and fails when GitHub can't show the team", async () => {
    const { source } = fakeGitHub({ "/orgs/acme/teams/devs/members": [{ login: "bob" }, { login: "carol" }] });
    expect(await source.teamMembers("acme/devs")).toEqual(["bob", "carol"]);
    await expect(source.teamMembers("acme/ghosts")).rejects.toThrow();
  });
});
