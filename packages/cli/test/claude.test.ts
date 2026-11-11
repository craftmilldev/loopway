import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { deny } from "../src/asks.js";
import { claudeArgs, claudeRunner, type AgentRun } from "../src/claude.js";
import { startMcp, type McpServer } from "../src/mcp.js";
import { Sessions } from "../src/sessions.js";
import { Threads } from "../src/threads.js";
import { fakeOpening, harness } from "./fake.js";
import { aBot } from "./make.js";

/** The tools of the MCP that a test does not use. */
const noAsks = { ask: async () => "", permission: async () => deny("no") };

const fakeClaude = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

const noCreating = {
  createIssue: async () => {
    throw new Error("not here");
  },
  createPr: async () => {
    throw new Error("not here");
  },
};

const aRun = (over: Partial<AgentRun> = {}): AgentRun => ({
  sessionId: "sid",
  resume: false,
  message: "hello",
  cwd: tmpdir(),
  env: { ...process.env },
  mcpUrl: "http://127.0.0.1:1/mcp/t1",
  onLine: () => {},
  onStarted: () => {},
  ...over,
});

describe("claudeArgs", () => {
  it("starts a session with its id, in auto mode, with stream-json out and loopway's MCP in", () => {
    const args = claudeArgs(aRun({ model: "sonnet" }));
    expect(args.slice(0, 4)).toEqual(["-p", "--session-id", "sid", "--model"]);
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--allowedTools") + 3)).toEqual([
      "mcp__loopway__comment",
      "mcp__loopway__ask",
    ]);
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("mcp__loopway__permission");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({
      mcpServers: { loopway: { type: "http", url: "http://127.0.0.1:1/mcp/t1" } },
    });
  });

  it("resumes a session by its id, and leaves the model to Claude Code when there is none", () => {
    const args = claudeArgs(aRun({ resume: true }));
    expect(args.slice(0, 3)).toEqual(["-p", "--resume", "sid"]);
    expect(args).not.toContain("--model");
  });
});

describe("claudeRunner, over a script that stands in for claude", () => {
  const run = (mode: string, extra: Record<string, string> = {}, over: Partial<AgentRun> = {}) =>
    claudeRunner(fakeClaude)(aRun({ env: { ...process.env, FAKE_CLAUDE: mode, ...extra }, ...over }));

  it("sends the message on stdin, reports the session, and turns the stream into log lines", async () => {
    const record = join(await mkdtemp(join(tmpdir(), "loopway-claude-")), "record.jsonl");
    const lines: string[] = [];
    let started = 0;
    const outcome = await run(
      "ok",
      { FAKE_RECORD: record },
      { onLine: (l) => lines.push(l), onStarted: () => started++ },
    );
    expect(outcome).toEqual({ code: 0, finished: true, limitedUntil: undefined, apiError: undefined });
    expect(started).toBe(1);
    expect(lines).toEqual(["── run started ──", "On it.", "── run finished ──"]);
    const sent = JSON.parse((await readFile(record, "utf8")).trim()) as { args: string[]; message: string };
    expect(sent.message).toBe("hello");
    expect(sent.args).toContain("stream-json");
  });

  it("reports an API error that came back as a finished run", async () => {
    expect(await run("api")).toMatchObject({ code: 0, finished: true, apiError: "API Error: 529 overloaded" });
  });

  it("reports the usage limit with the time it resets", async () => {
    const resets = Math.floor(Date.now() / 1000) + 7200;
    const outcome = await run("limit", { FAKE_RESETS: String(resets) });
    expect(outcome).toMatchObject({ limitedUntil: resets * 1000, apiError: undefined });
  });

  it("reports a run that was killed", async () => {
    expect(await run("die")).toMatchObject({ code: 1, finished: false });
  });

  it("fails when claude is not there", async () => {
    await expect(claudeRunner("/no/such/claude")(aRun())).rejects.toThrow();
  });
});

describe("loopway's MCP server", () => {
  let mcp: McpServer | undefined;
  afterEach(() => mcp?.close());

  const call = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
  };

  it("lists its comment tool, and runs it for the thread whose URL the session was given", async () => {
    const calls: unknown[][] = [];
    mcp = await startMcp({
      ...noAsks,
      ...noCreating,
      comment: async (...args) => {
        calls.push(args);
        return "https://github.com/o/r/issues/1#issuecomment-9";
      },
    });
    const url = mcp.urlFor("t1");
    const init = await call(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "loopway" } });
    expect((await call(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await call(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "comment",
      "ask",
      "create_issue",
      "create_pr",
      "permission",
    ]);
    const made = await call(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "comment", arguments: { subject: "o/r#1", body: "hi" } },
    });
    expect(made.body.result).toEqual({
      content: [{ type: "text", text: "posted https://github.com/o/r/issues/1#issuecomment-9" }],
      isError: false,
    });
    expect(calls).toEqual([["t1", "o/r#1", "hi"]]);
  });

  it("runs create_issue and create_pr for the thread, and answers with the new subject", async () => {
    const calls: unknown[][] = [];
    const made = (key: string, url: string) => ({
      url,
      subject: { key, kind: "issue" as const, title: "t", author: "loopway-bot", createdAt: "2026-11-10T13:00:00Z" },
    });
    mcp = await startMcp({
      ...noAsks,
      ...noCreating,
      comment: async () => "",
      createIssue: async (...args) => (calls.push(args), made("o/r#7", "https://github.com/o/r/issues/7")),
      createPr: async (...args) => (calls.push(args), made("o/r#8", "https://github.com/o/r/pull/8")),
    });
    const tool = (name: string, args: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const issue = await call(
      mcp.urlFor("t1"),
      tool("create_issue", { repo: "o/r", title: "Follow up", body: "Do it." }),
    );
    expect(issue.body.result).toEqual({
      content: [{ type: "text", text: "created o/r#7: https://github.com/o/r/issues/7" }],
      isError: false,
    });
    const pr = await call(
      mcp.urlFor("t1"),
      tool("create_pr", { repo: "o/r", head: "fix", base: "main", title: "Fix", body: "" }),
    );
    expect(pr.body.result.content[0].text).toBe("created o/r#8: https://github.com/o/r/pull/8");
    expect(calls).toEqual([
      ["t1", "o/r", "Follow up", "Do it."],
      ["t1", "o/r", "fix", "main", "Fix", ""],
    ]);
  });

  it("answers a failed or malformed create_issue or create_pr as a tool error the session can read", async () => {
    mcp = await startMcp({ ...noAsks, ...noCreating, comment: async () => "" });
    const tool = (name: string, args: unknown) =>
      call(mcp!.urlFor("t1"), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
    const failed = await tool("create_issue", { repo: "o/r", title: "x", body: "y" });
    expect(failed.body.result).toMatchObject({
      isError: true,
      content: [{ text: "could not create the issue: not here" }],
    });
    const failedPr = await tool("create_pr", { repo: "o/r", head: "a", base: "main", title: "x", body: "y" });
    expect(failedPr.body.result.content[0].text).toBe("could not create the pull request: not here");
    expect((await tool("create_issue", { repo: "o/r", body: "y" })).body.result.isError).toBe(true);
    expect((await tool("create_pr", { repo: "o/r", head: "a", title: "x", body: "y" })).body.result.isError).toBe(true);
  });

  it("answers a failed or malformed comment as a tool error the session can read", async () => {
    mcp = await startMcp({
      ...noAsks,
      ...noCreating,
      comment: async () => {
        throw new Error("dev does not read x/y");
      },
    });
    const url = mcp.urlFor("t1");
    const args = (a: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "comment", arguments: a },
    });
    const failed = await call(url, args({ subject: "x/y#1", body: "hi" }));
    expect(failed.body.result).toMatchObject({
      isError: true,
      content: [{ text: "could not comment: dev does not read x/y" }],
    });
    const malformed = await call(url, args({ subject: "x/y#1" }));
    expect(malformed.body.result.isError).toBe(true);
  });

  it("refuses other methods and other paths", async () => {
    mcp = await startMcp({ ...noAsks, ...noCreating, comment: async () => "" });
    const unknown = await call(mcp.urlFor("t1"), { jsonrpc: "2.0", id: 1, method: "resources/list" });
    expect(unknown.body.error.code).toBe(-32601);
    expect((await call(mcp.urlFor("t1").replace("/mcp/t1", "/other"), {})).status).toBe(404);
  });
});

describe("the whole loop: poller, threads, sessions, MCP and a claude stand-in", () => {
  it("records what a thread sent, and queues it to the other threads on the subject but never back to its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loopway-loop-"));
    const bots = [aBot("dev", ["issue"]), aBot("scribe", ["issue"])];
    let n = 0;
    const threads = await Threads.load({ dir, bots, newId: () => `t${++n}` });
    const posted: string[] = [];
    // eslint-disable-next-line prefer-const
    let sessions: Sessions;
    const mcp = await startMcp({
      ...noAsks,
      ...noCreating,
      comment: (id, subject, body) => sessions.comment(id, subject, body),
    });
    const h = harness({
      start: "2026-11-10T12:00:00Z",
      react: async (event, push) => void (await threads.handle(event)).forEach(push),
    });
    sessions = new Sessions({
      dir,
      threads,
      bots,
      root: tmpdir(),
      max: 3,
      runAgent: claudeRunner(fakeClaude),
      mcpUrl: (id) => mcp.urlFor(id),
      env: { FAKE_CLAUDE: "comment", FAKE_SUBJECT: "o/r#12" },
      github: {
        ...fakeOpening(),
        comment: async (_subject, body) => {
          posted.push(body);
          return `https://github.com/o/r/issues/12#issuecomment-${posted.length}`;
        },
      },
      created: async () => {},
      emit: () => {},
    });
    try {
      await h.poller.discover();
      h.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
      await h.poller.discover();
      h.source.say("o/r#12", { id: "comment:1:x", body: "What's 2+2?" });
      await h.poller.updates();
      sessions.kick();
      await sessions.idle();

      // Each thread heard the question, ran, and sent one comment.
      const [t1, t2] = threads.all;
      expect(threads.all.map((t) => [t.id, t.session?.status, t.sent?.length, t.queue.length])).toEqual([
        ["t1", "idle", 1, 0],
        ["t2", "idle", 1, 0],
      ]);
      expect(t1?.session?.id).toMatch(/^[0-9a-f-]{36}$/);
      const from = (id: string) => posted.find((b) => b.includes(`thread=${id} -->`));
      expect(from("t1")).toBeDefined();

      // The poller now sees both comments, as loopway-bot.
      posted.forEach((body, i) => h.source.say("o/r#12", { id: `comment:${i + 2}:x`, actor: "loopway-bot", body }));
      await h.poller.updates();
      expect(t1?.queue.map((q) => q.body)).toEqual([from("t2")]);
      expect(t2?.queue.map((q) => q.body)).toEqual([from("t1")]);
    } finally {
      await mcp.close();
    }
  });
});

describe("the whole loop for a thread that opens an issue and a pull request", () => {
  it("tracks both, starts a dev and a review thread for them, and discovery does not start them again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loopway-open-"));
    const record = join(dir, "record.jsonl");
    const bots = [aBot("dev", ["issue"]), aBot("review", ["pull_request"])];
    let n = 0;
    const threads = await Threads.load({ dir, bots, newId: () => `t${++n}` });
    // eslint-disable-next-line prefer-const
    let sessions: Sessions;
    const mcp = await startMcp({
      ...noAsks,
      comment: (id, subject, body) => sessions.comment(id, subject, body),
      createIssue: (id, repo, title, body) => sessions.createIssue(id, repo, title, body),
      createPr: (id, repo, head, base, title, body) => sessions.createPr(id, repo, head, base, title, body),
    });
    const h = harness({
      start: "2026-11-10T12:00:00Z",
      react: async (event, push) => void (await threads.handle(event)).forEach(push),
    });
    const github = fakeOpening();
    sessions = new Sessions({
      dir,
      threads,
      bots,
      root: tmpdir(),
      max: 3,
      runAgent: claudeRunner(fakeClaude),
      mcpUrl: (id) => mcp.urlFor(id),
      env: { FAKE_CLAUDE: "open", FAKE_SUBJECT: "o/r#12", FAKE_RECORD: record },
      github: { ...github, comment: async () => "" },
      created: async (thread, subject) => {
        await h.poller.know(subject);
        for (const e of await threads.handle({ type: "created", thread, subject })) h.events.push(e);
      },
      emit: () => {},
    });
    try {
      await h.poller.discover();
      h.source.add("o/r#12", "me", "2026-11-10T12:01:00Z");
      await h.poller.discover();
      sessions.kick();
      await sessions.idle();

      const [t1, t2, t3] = threads.all;
      expect(threads.all.map((t) => [t.id, t.bot, t.subjects.map((s) => s.key)])).toEqual([
        ["t1", "dev", ["o/r#12", "o/r#101", "o/r#102"]],
        ["t2", "dev", ["o/r#101"]],
        ["t3", "review", ["o/r#102"]],
      ]);
      expect(t1?.sent?.map((m) => [m.kind, m.subject])).toEqual([
        ["issue", "o/r#101"],
        ["pull_request", "o/r#102"],
      ]);
      // Each new thread was started with the creation as its news, and the marker went out in what was opened.
      const messages = (await readFile(record, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).message as string);
      expect(messages).toHaveLength(3);
      expect(messages.join("\n")).toContain(
        "tracks: o/r#101. Read them with gh.\n\n1 updates since your last turn, oldest first:\n- 2026-11-10T15:00:00Z o/r#101 created by loopway-bot",
      );
      expect(messages.join("\n")).toContain("o/r#102 created by loopway-bot");
      expect(github.opened.every((o) => o.endsWith(`<!-- loopway:thread=${t1?.id} -->`))).toBe(true);
      expect([t2?.session?.status, t3?.session?.status]).toEqual(["idle", "idle"]);

      // Discovery now finds both, by loopway-bot, and starts nothing.
      for (const [key, kind] of [
        ["o/r#101", "issue"],
        ["o/r#102", "pull_request"],
      ] as const)
        h.source.add(key, "loopway-bot", "2026-11-10T15:00:00Z", kind, `x\n\n<!-- loopway:thread=${t1?.id} -->`);
      await h.poller.discover();
      expect(threads.all).toHaveLength(3);
    } finally {
      await mcp.close();
    }
  });
});
