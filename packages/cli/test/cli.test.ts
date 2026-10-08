import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "@loopway/web/api";
import { openDb, type Db } from "@loopway/web/db";
import { createUser } from "@loopway/web/store";
import { signSessionToken } from "@loopway/web/tokens";
import type { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LoopwayClient } from "../src/client.js";
import { threadPrompt, type AgentRun } from "../src/threads/agent.js";
import { Dispatcher } from "../src/threads/dispatcher.js";
import { loadConfig, loadGithubBot, writeConfig } from "../src/config.js";
import { botEnv } from "../src/threads/github.js";
import type { Context } from "../src/context.js";
import { createProgram } from "../src/program.js";
import { withSessions } from "../src/threads/store.js";

const API = "https://loopway.test";
const SECRET = "test-secret";

let db: Db;
let app: ReturnType<typeof createApi>;
let configDir: string;
const emails: { to: string; text: string }[] = [];

// The CLI talks to the real API app in-process; only the network hop is skipped.
const apiFetch = ((input: string | URL | Request, init?: RequestInit) => app.request(input, init)) as typeof fetch;

beforeAll(async () => {
  db = await openDb({ pgliteDir: "memory://" });
  app = createApi({
    getDb: async () => db,
    publicBaseUrl: API,
    tokenSecret: SECRET,
    sendEmail: async (e) => void emails.push(e),
  });
});
afterAll(() => db.close());

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "loopway-cli-"));
});
afterEach(() => rm(configDir, { recursive: true, force: true }));

// ---------- helpers ----------

async function run(...args: string[]) {
  const out: string[] = [];
  const ctx: Context = { configDir, env: {}, interactive: false, out: (t) => out.push(t), fetch: apiFetch };
  const program = createProgram(ctx);
  // Throw instead of exiting on usage errors; these settings don't propagate to existing subcommands.
  const quiet = (c: Command) => {
    c.exitOverride().configureOutput({ writeOut: (s) => out.push(s), writeErr: () => {} });
    c.commands.forEach(quiet);
  };
  quiet(program);
  await program.parseAsync(args, { from: "user" });
  return out.join("\n");
}

const runJson = async (...args: string[]) => JSON.parse(await run(...args, "--json"));

/** What's on disk in config.json, or undefined if it wasn't written. */
const savedConfig = (dir = configDir) => readFile(join(dir, "config.json"), "utf8").then(JSON.parse, () => undefined);

async function configured(name = "Matthew") {
  const { user } = await createUser(db, { name });
  const key = signSessionToken(user.id, SECRET).token;
  await run("config", "--url", API, "--key", key);
  return key;
}

async function sendGithub(inbox: { id: string; config: { secret: string } }, event: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const res = await app.request(`/webhooks/${inbox.id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": "sha256=" + createHmac("sha256", inbox.config.secret).update(raw).digest("hex"),
    },
    body: raw,
  });
  expect(res.status).toBe(202);
}

const pr = (n: number) => ({ action: "opened", number: n, repository: { url: "https://api.github.com/repos/a/b" } });

async function inboxWithEvents(n: number, name = "gh") {
  const inbox = await runJson("inbox", "create", "--name", name, "--source", "github");
  for (let i = 1; i <= n; i++) await sendGithub(inbox, "pull_request", pr(i));
  return inbox as { id: string; name: string; config: { secret: string } };
}

// ---------- tests ----------

describe("auth", () => {
  it("config verifies the key and writes ~/.loopway/config.json owner-only", async () => {
    const key = await configured();
    expect(await savedConfig()).toEqual({ api_url: API, api_key: key });
    expect((await stat(join(configDir, "config.json"))).mode & 0o777).toBe(0o600);
    expect(await runJson("whoami")).toMatchObject({ name: "Matthew", api_url: API });
  });

  it("login trades an emailed code for a session token and saves it", async () => {
    await createUser(db, { name: "Matthew", email: "m@example.com" });
    await expect(run("login", "--url", API, "--email", "m@example.com")).rejects.toThrow(/--code is required/);
    const code = emails.at(-1)!.text.match(/\b([0-9A-Z]{8})\b/)![1]!;
    expect(await run("login", "--url", API, "--email", "m@example.com", "--code", code)).toMatch(/Logged in/);
    expect((await savedConfig()).api_url).toBe(API);
    expect(await runJson("whoami")).toMatchObject({ name: "Matthew", email: "m@example.com" });
  });

  it("login creates an account for an unknown email once the code is entered", async () => {
    await expect(run("login", "--url", API, "--email", "fresh@example.com")).rejects.toThrow(/--code is required/);
    const code = emails.at(-1)!.text.match(/\b([0-9A-Z]{8})\b/)![1]!;
    expect(await run("login", "--url", API, "--email", "fresh@example.com", "--code", code)).toMatch(
      /Created your account/,
    );
    expect(await runJson("whoami")).toMatchObject({ name: "fresh", email: "fresh@example.com" });
  });

  it("login rejects a wrong code without saving anything", async () => {
    await createUser(db, { name: "Other", email: "o@example.com" });
    await expect(run("login", "--url", API, "--email", "o@example.com")).rejects.toThrow();
    await expect(run("login", "--url", API, "--email", "o@example.com", "--code", "00000000")).rejects.toThrow(
      /invalid or has expired/,
    );
    expect(await savedConfig()).toBeUndefined();
  });

  it("config rejects a bad key without saving it", async () => {
    await expect(run("config", "--url", API, "--key", "nope")).rejects.toThrow(/rejected that token/);
    expect(await savedConfig()).toBeUndefined();
  });

  it("config changes the URL and keeps the saved token", async () => {
    const key = await configured();
    expect(await run("config", "--url", "https://other.test")).toMatch(/Configured https:\/\/other\.test as/);
    expect(await savedConfig()).toEqual({ api_url: "https://other.test", api_key: key });
  });

  it("config without a token saves just the URL for login to use", async () => {
    expect(await run("config", "--url", API)).toMatch(/Run `loopway login`/);
    expect(await savedConfig()).toEqual({ api_url: API });
    expect(await loadConfig(configDir, {})).toEqual({ api_url: API, api_key: undefined });
  });

  it("config points at login when the saved token is rejected", async () => {
    await writeConfig(configDir, { api_url: API, api_key: "stale" });
    await expect(run("config", "--url", API)).rejects.toThrow(/rejected your saved token\. Run `loopway login/);
    expect(await savedConfig()).toEqual({ api_url: API, api_key: "stale" });
  });

  it("commands fail clearly when not configured", async () => {
    await configured();
    expect(await run("clear-config")).toMatch(/Removed .*config\.json/);
    await expect(run("inbox", "list")).rejects.toThrow(/No API key configured/);
  });

  it("loadConfig: env over config.json over defaults; trailing slashes dropped on save", async () => {
    expect(await loadConfig(configDir, {})).toEqual({ api_url: "https://loopway.craftmill.dev", api_key: undefined });
    await writeConfig(configDir, { api_url: "https://file.test/", api_key: "lw_file" });
    expect(await loadConfig(configDir, {})).toEqual({ api_url: "https://file.test", api_key: "lw_file" });
    expect(await loadConfig(configDir, { LOOPWAY_API_URL: "https://env.test", LOOPWAY_API_KEY: "lw_env" })).toEqual({
      api_url: "https://env.test",
      api_key: "lw_env",
    });
  });

  it("loadGithubBot: env over config.json; all three or none; config and login keep it", async () => {
    expect(await loadGithubBot(configDir, {})).toBeUndefined();
    const github = { token: "ghp_file", name: "file-bot", email: "1+file-bot@users.noreply.github.com" };
    await writeFile(join(configDir, "config.json"), JSON.stringify({ github }));
    expect(await loadGithubBot(configDir, {})).toEqual(github);
    expect(await loadGithubBot(configDir, { LOOPWAY_GITHUB_TOKEN: "ghp_env" })).toEqual({
      ...github,
      token: "ghp_env",
    });

    await configured();
    expect(await savedConfig()).toMatchObject({ api_url: API, github });

    await writeFile(join(configDir, "config.json"), JSON.stringify({ github: { token: "ghp_file" } }));
    await expect(loadGithubBot(configDir, {})).rejects.toThrow(/needs a token, name and email/);
    await expect(
      loadGithubBot(configDir, { LOOPWAY_GITHUB_NAME: "b", LOOPWAY_GITHUB_EMAIL: "b@x" }),
    ).resolves.toMatchObject({ name: "b" });
  });

  it("botEnv: git commits as the bot and gets its token for github.com, SSH remotes included", () => {
    const env = botEnv(
      {
        PATH: process.env.PATH,
        HOME: configDir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "!echo password=user-token #",
      },
      { token: "ghp_bot", name: "loopway-bot", email: "2+loopway-bot@users.noreply.github.com" },
    );
    const git = (args: string[], input?: string) => execFileSync("git", args, { env, input, encoding: "utf8" });
    expect(env).toMatchObject({ GH_TOKEN: "ghp_bot", GITHUB_TOKEN: "ghp_bot" });
    expect(git(["var", "GIT_AUTHOR_IDENT"])).toMatch(/^loopway-bot <2\+loopway-bot@users\.noreply\.github\.com>/);
    expect(git(["var", "GIT_COMMITTER_IDENT"])).toMatch(/^loopway-bot </);
    // The helper the environment already had is reset for github.com, so the user's token never answers.
    expect(git(["credential", "fill"], "protocol=https\nhost=github.com\n\n")).toContain("password=ghp_bot");
    expect(git(["ls-remote", "--get-url", "git@github.com:a/b.git"]).trim()).toBe("https://github.com/a/b.git");
  });

  it("env vars override the config file", async () => {
    const { user } = await createUser(db, { name: "Env" });
    const apiKey = signSessionToken(user.id, SECRET).token;
    const out: string[] = [];
    const ctx: Context = {
      configDir,
      env: { LOOPWAY_API_URL: API, LOOPWAY_API_KEY: apiKey },
      interactive: false,
      out: (t) => out.push(t),
      fetch: apiFetch,
    };
    await createProgram(ctx).parseAsync(["whoami", "--json"], { from: "user" });
    expect(JSON.parse(out.join(""))).toMatchObject({ name: "Env" });
  });
});

describe("inboxes", () => {
  it("creates from flags and lists", async () => {
    await configured();
    const inbox = await runJson(
      "inbox",
      "create",
      "--name",
      "prs",
      "--source",
      "github",
      "--events",
      "push, pull_request",
    );
    expect(inbox.config.events).toEqual(["push", "pull_request"]);
    expect(inbox.webhook_url).toBe(`${API}/webhooks/${inbox.id}`);

    const list = await runJson("inbox", "list");
    expect(list.map((i: any) => i.id)).toEqual([inbox.id]);
    expect(await run("inbox", "ls")).toContain("prs");
  });

  it("requires --name without a terminal", async () => {
    await configured();
    await expect(run("inbox", "create", "--source", "github")).rejects.toThrow(/--name is required/);
  });

  it("show resolves names and reports stats", async () => {
    await configured();
    const inbox = await inboxWithEvents(2, "named");
    const shown = await runJson("inbox", "show", "named");
    expect(shown.id).toBe(inbox.id);
    expect(shown.stats).toEqual({ pending: 2, locked: 0, processed: 0 });
    await expect(run("inbox", "show", "nope")).rejects.toThrow(/No inbox with id or name/);
  });

  it("creates a vercel inbox without a secret and sets it with update", async () => {
    await configured();
    const inbox = await runJson(
      "inbox",
      "create",
      "--name",
      "vc",
      "--source",
      "vercel",
      "--events",
      "deployment.error",
    );
    expect(inbox.config).toEqual({ secret: null, events: ["deployment.error"] });
    await expect(run("inbox", "update", "vc")).rejects.toThrow(/Pass --name, --events or --secret/);
    const updated = await runJson("inbox", "update", "vc", "--secret", "from-vercel");
    expect(updated.config).toEqual({ secret: "from-vercel", events: ["deployment.error"] });
    expect(await run("inbox", "update", inbox.id, "--name", "vercel")).toMatch(/Updated inbox .*vercel/);
  });

  it("creates a granola inbox without a secret and sets it with update", async () => {
    await configured();
    const inbox = await runJson("inbox", "create", "--name", "notes", "--source", "granola");
    expect(inbox.config).toEqual({ secret: null, events: ["*"] });
    const secret = "whsec_" + Buffer.from("granola-key").toString("base64");
    const updated = await runJson("inbox", "update", "notes", "--secret", secret);
    expect(updated.config).toEqual({ secret, events: ["*"] });
    expect(updated.setup.secret).toBe("set");
  });
});

describe("events", () => {
  it("list filters, paginates with --all, and get shows one", async () => {
    await configured();
    const inbox = await inboxWithEvents(3);
    const page = await runJson("events", "list", inbox.id, "--limit", "2");
    expect(page.data).toHaveLength(2);
    expect(page.next_cursor).toBeTruthy();

    const all = await runJson("events", "list", inbox.id, "--limit", "2", "--all");
    expect(all.data).toHaveLength(3);
    expect(all.next_cursor).toBeNull();
    expect(await run("events", "list", inbox.id)).toContain("com.github.pull_request.opened");

    const id = all.data[0].id;
    expect((await runJson("events", "get", inbox.id, id)).event.subject).toBe("1");
    expect(JSON.parse(await run("events", "get", inbox.id, id, "--data"))).toEqual(pr(1));
  });

  it("next → done uses the remembered lock token", async () => {
    await configured();
    const inbox = await inboxWithEvents(1);
    const claimed = await runJson("events", "next", inbox.name, "--ttl", "60");
    expect(claimed.lock.token).toMatch(/^lk_/);
    const locks = JSON.parse(await readFile(join(configDir, "locks.json"), "utf8"));
    expect(locks[claimed.id].token).toBe(claimed.lock.token);

    // nothing else to claim; --json prints nothing, like the API's 204
    expect(await run("events", "next", inbox.id, "--json")).toBe("");
    expect(await run("events", "next", inbox.id)).toMatch(/No events waiting/);

    const done = await runJson("events", "done", inbox.id, claimed.id);
    expect(done.status).toBe("processed");
    expect(JSON.parse(await readFile(join(configDir, "locks.json"), "utf8"))).toEqual({});
  });

  it("lock renews with the held token, unlock releases it", async () => {
    await configured();
    const inbox = await inboxWithEvents(1);
    const [{ id }] = (await runJson("events", "list", inbox.id)).data;
    const first = await runJson("events", "lock", inbox.id, id, "--ttl", "30");
    const renewed = await runJson("events", "lock", inbox.id, id, "--ttl", "120");
    expect(renewed.lock.token).toBe(first.lock.token);
    expect(renewed.lock_count).toBe(1);

    expect((await runJson("events", "unlock", inbox.id, id)).status).toBe("pending");
    await expect(run("events", "unlock", inbox.id, id)).rejects.toThrow(/doesn't hold a lock/);
  });

  it("surfaces API conflicts", async () => {
    await configured();
    const inbox = await inboxWithEvents(1);
    const [{ id }] = (await runJson("events", "list", inbox.id)).data;
    await runJson("events", "lock", inbox.id, id);
    // another machine (its own config dir, same key) doesn't hold the token, so it can't take the event
    const first = configDir;
    const key = (await savedConfig(first)).api_key;
    configDir = await mkdtemp(join(tmpdir(), "loopway-cli-"));
    try {
      await run("config", "--url", API, "--key", key);
      await expect(run("events", "lock", inbox.id, id)).rejects.toThrow(/locked until/);
      await expect(run("events", "done", inbox.id, id)).rejects.toThrow(/locked until/);
    } finally {
      await rm(first, { recursive: true, force: true });
    }
  });

  it("rejects bad numbers before calling the API", async () => {
    await configured();
    await expect(run("events", "next", "x", "--ttl", "0")).rejects.toThrow(/positive integer/);
  });
});

describe("threads", () => {
  const repository = { full_name: "a/b", url: "https://api.github.com/repos/a/b" };
  const issue = (action: string, n: number) => ({ action, issue: { number: n }, repository });
  const comment = (n: number) => ({ action: "created", issue: { number: n }, comment: { body: "hi" }, repository });
  const pull = (action: string, n: number, body = "") => ({
    action,
    number: n,
    pull_request: { number: n, body },
    repository,
  });
  const sessions = async () => JSON.parse(await readFile(join(configDir, "threads.json"), "utf8"));
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => void (await Promise.all(closers.splice(0).map((c) => c()))));

  async function setup(max: number, env: NodeJS.ProcessEnv = {}) {
    const key = await configured();
    const inbox = await runJson("inbox", "create", "--name", "gh", "--source", "github");
    const runs: AgentRun[] = [];
    const busy: (() => void)[] = [];
    const out: string[] = [];
    const ctx: Context = {
      configDir,
      env,
      interactive: false,
      out: (t) => out.push(t),
      fetch: apiFetch,
      // Each run stays "busy" until the test calls finish().
      runAgent: (r) => new Promise((resolve) => (runs.push(r), busy.push(() => resolve(0)))),
    };
    const client = new LoopwayClient({ baseUrl: API, apiKey: key, fetch: apiFetch });
    const d = await Dispatcher.start(ctx, client, inbox.id, { max, ttl: 60 });
    const finish = async () => (busy.splice(0).forEach((f) => f()), await d.idle());
    // Let runs still in flight write threads.json before the config dir is removed.
    closers.push(async () => (await finish(), await d.close()));
    const list = async (status: string) => (await runJson("events", "list", inbox.id, "--status", status)).data;
    return { inbox, runs, out, d, finish, list };
  }

  /** Calls one of the dispatcher's MCP methods the way Claude Code would. */
  async function mcp(url: string, method: string, params?: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as { result: any }).result;
  }

  it("routes events by issue/PR, batches while busy, follows Closes #N, and ends when the session says so", async () => {
    const { inbox, runs, out, d, finish, list } = await setup(3);
    await sendGithub(inbox, "issues", issue("opened", 1));
    await sendGithub(inbox, "issue_comment", comment(1));
    await d.tick();
    expect(runs).toHaveLength(1);
    const [first] = runs;
    expect(first!.resume).toBe(false);
    expect(first!.message).toContain("You are a loopway thread session");
    expect(first!.message.split("New events for this thread:\n")[1]!.split("\n")).toHaveLength(2);
    expect(await list("pending")).toHaveLength(0);

    // While the run is busy, its new events wait; others' don't.
    await sendGithub(inbox, "issue_comment", comment(1));
    await d.tick();
    expect(runs).toHaveLength(1);
    await finish();
    expect((await sessions())[first!.sessionId]).toMatchObject({ keys: ["a/b#1"], status: "active", started: true });

    await d.tick(); // the comment that arrived while busy
    expect(runs[1]).toMatchObject({ sessionId: first!.sessionId, resume: true });
    expect(runs[1]!.message).not.toContain("## 1. Triage");
    await finish();

    // A PR that closes #1 joins that thread.
    await sendGithub(inbox, "pull_request", pull("opened", 2, "Adds it.\n\nCloses #1"));
    await d.tick();
    expect(runs[2]!.sessionId).toBe(first!.sessionId);
    await finish();
    expect((await sessions())[first!.sessionId].keys).toEqual(["a/b#1", "a/b#2"]);

    // A close event alone doesn't end the thread; the session decides, through its end tool.
    await sendGithub(inbox, "pull_request", pull("closed", 2));
    await d.tick();
    expect((await mcp(first!.mcpUrl, "tools/call", { name: "end", arguments: {} })).content[0].text).toMatch(/Ended/);
    await finish();
    expect((await sessions())[first!.sessionId].status).toBe("ended");
    expect(out.at(-1)).toMatch(/ended \(exit 0\)/);

    // A later event resumes it and makes it active again.
    await sendGithub(inbox, "issue_comment", comment(2));
    await d.tick();
    expect(runs.at(-1)).toMatchObject({ sessionId: first!.sessionId, resume: true });
    expect((await sessions())[first!.sessionId].status).toBe("active");
  });

  it("marks events processed as it delivers them, and records them on the session", async () => {
    const { inbox, runs, d, finish, list } = await setup(3);
    await sendGithub(inbox, "issues", issue("opened", 1));
    await d.tick();
    expect(await list("locked")).toHaveLength(0);
    const [delivered] = await list("processed");
    const id = runs[0]!.sessionId;
    expect(runs[0]!.message).toContain(delivered.id);
    await finish();

    // The session never marks it done; later ticks leave it processed and still recorded.
    await d.tick();
    expect(runs).toHaveLength(1);
    expect(await list("processed")).toHaveLength(1);
    expect((await sessions())[id].events).toEqual([delivered.id]);
  });

  it("never runs more than --max sessions at once, but sessions waiting on their thread don't count", async () => {
    const { inbox, runs, out, d, finish, list } = await setup(2);
    await sendGithub(inbox, "issues", issue("opened", 1));
    await sendGithub(inbox, "issues", issue("opened", 2));
    await sendGithub(inbox, "issues", issue("opened", 3));
    await d.tick();
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.sessionId)).size).toBe(2);
    expect(await list("pending")).toHaveLength(1);
    expect(out.join("\n")).toMatch(/1 event\(s\) waiting: 2 sessions are already running/);
    // The TUI's view: the queued event is raw, and both sessions are working.
    const state = await d.state();
    expect(state.raw.map((e) => e.id)).toEqual((await list("pending")).map((e: any) => e.id));
    expect([...state.running].sort()).toEqual(Object.keys(state.sessions).sort());

    // Once their runs exit, both sessions wait on their threads (still active) without holding a
    // slot, so the queued issue starts right away.
    const freed = d.slotFreed();
    await finish();
    await freed;
    await d.tick();
    expect(runs).toHaveLength(3);
    expect(await list("pending")).toHaveLength(0);
    expect(Object.values(await sessions()).map((s: any) => s.status)).toEqual(["active", "active", "active"]);

    // With one slot left, new events for the two waiting threads go oldest first; the other waits.
    await sendGithub(inbox, "issue_comment", comment(1));
    await sendGithub(inbox, "issue_comment", comment(2));
    const [oldest] = await list("pending");
    await d.tick();
    expect(runs).toHaveLength(4);
    expect(runs[3]!.resume).toBe(true);
    expect(runs[3]!.message).toContain(oldest.id);
    expect(await list("pending")).toHaveLength(1);

    // A run exiting frees its slot for the event still waiting.
    await finish();
    await d.tick();
    expect(runs).toHaveLength(5);
    expect(await list("pending")).toHaveLength(0);
    await finish();
  });

  it("serves a link tool that routes a PR's events to the session", async () => {
    const { inbox, runs, d, finish } = await setup(3);
    await sendGithub(inbox, "issues", issue("opened", 5));
    await d.tick();
    const url = runs[0]!.mcpUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect((await mcp(url, "initialize", { protocolVersion: "2025-06-18" })).serverInfo.name).toBe("loopway");
    expect((await mcp(url, "tools/list")).tools.map((t: any) => t.name)).toEqual(["link", "end"]);
    expect((await mcp(url, "tools/call", { name: "link", arguments: { number: 9 } })).content[0].text).toMatch(
      /Linked a\/b#9/,
    );
    await mcp(url, "tools/call", { name: "link", arguments: { number: 3, repo: "c/d" } });
    expect((await mcp(url, "tools/call", { name: "link", arguments: { number: "x" } })).isError).toBe(true);
    await finish();
    expect((await sessions())[runs[0]!.sessionId].keys).toEqual(["a/b#5", "a/b#9", "c/d#3"]);

    // A comment on the linked PR now resumes the session instead of starting a new one.
    await sendGithub(inbox, "issue_comment", comment(9));
    await d.tick();
    expect(runs[1]).toMatchObject({ sessionId: runs[0]!.sessionId, resume: true });
  });

  it("runs sessions as the GitHub bot when one is configured", async () => {
    const plain = await setup(3);
    await sendGithub(plain.inbox, "issues", issue("opened", 1));
    await plain.d.tick();
    expect(plain.runs[0]!.env.GH_TOKEN).toBeUndefined();

    const bot = {
      LOOPWAY_GITHUB_TOKEN: "ghp_bot",
      LOOPWAY_GITHUB_NAME: "loopway-bot",
      LOOPWAY_GITHUB_EMAIL: "2+loopway-bot@users.noreply.github.com",
    };
    const { inbox, runs, d } = await setup(3, bot);
    await sendGithub(inbox, "issues", issue("opened", 2));
    await d.tick();
    expect(runs[0]!.env).toMatchObject({
      GH_TOKEN: "ghp_bot",
      GIT_AUTHOR_NAME: "loopway-bot",
      GIT_COMMITTER_NAME: "loopway-bot",
      GIT_CONFIG_COUNT: "4",
    });
  });

  it("loads the session prompt from prompts/thread.md", async () => {
    const prompt = await threadPrompt("inbox-123");
    expect(prompt).toContain("events from inbox inbox-123");
    expect(prompt).not.toContain("{{");
  });

  it("serializes threads.json writes through its lock file", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withSessions(configDir, (s) => {
          s[`s${i}`] = {
            inbox_id: "x",
            keys: [],
            events: [],
            status: "active",
            started: false,
            created_at: "",
            updated_at: "",
          };
        }),
      ),
    );
    expect(Object.keys(await sessions())).toHaveLength(20);
    await expect(stat(join(configDir, "threads.json.lock"))).rejects.toThrow();
  });
});
