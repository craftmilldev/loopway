import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "@loopway/web/api";
import { openDb, type Db } from "@loopway/web/db";
import { createUser } from "@loopway/web/store";
import { signSessionToken } from "@loopway/web/tokens";
import type { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LoopwayClient } from "../src/client.js";
import { createDispatcher, type AgentRun } from "../src/commands/threads.js";
import { loadConfig, writeConfig } from "../src/config.js";
import type { Context } from "../src/context.js";
import { createProgram } from "../src/program.js";

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
  app = createApi({ getDb: async () => db, publicBaseUrl: API, tokenSecret: SECRET, sendEmail: async (e) => void emails.push(e) });
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
    expect(await run("login", "--url", API, "--email", "fresh@example.com", "--code", code)).toMatch(/Created your account/);
    expect(await runJson("whoami")).toMatchObject({ name: "fresh", email: "fresh@example.com" });
  });

  it("login rejects a wrong code without saving anything", async () => {
    await createUser(db, { name: "Other", email: "o@example.com" });
    await expect(run("login", "--url", API, "--email", "o@example.com")).rejects.toThrow();
    await expect(run("login", "--url", API, "--email", "o@example.com", "--code", "00000000")).rejects.toThrow(/invalid or has expired/);
    expect(await savedConfig()).toBeUndefined();
  });

  it("config rejects a bad key without saving it", async () => {
    await expect(run("config", "--url", API, "--key", "nope")).rejects.toThrow(/rejected that token/);
    expect(await savedConfig()).toBeUndefined();
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
    const inbox = await runJson("inbox", "create", "--name", "prs", "--source", "github", "--events", "push, pull_request");
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
  const pull = (action: string, n: number, body = "") => ({ action, number: n, pull_request: { number: n, body }, repository });
  const sessions = async () => JSON.parse(await readFile(join(configDir, "threads.json"), "utf8"));

  async function setup(max: number) {
    const key = await configured();
    const inbox = await runJson("inbox", "create", "--name", "gh", "--source", "github");
    const runs: AgentRun[] = [];
    const busy: (() => void)[] = [];
    const out: string[] = [];
    const ctx: Context = {
      configDir,
      env: {},
      interactive: false,
      out: (t) => out.push(t),
      fetch: apiFetch,
      // Each run stays "busy" until the test calls release().
      runAgent: (r) => new Promise((resolve) => (runs.push(r), busy.push(() => resolve(0)))),
    };
    const client = new LoopwayClient({ baseUrl: API, apiKey: key, fetch: apiFetch });
    const d = createDispatcher(ctx, client, inbox.id, { max });
    const finish = async () => (busy.splice(0).forEach((f) => f()), await d.idle());
    const pending = async () => (await runJson("events", "list", inbox.id, "--status", "pending")).data.length;
    return { inbox, runs, out, d, finish, pending };
  }

  it("routes events by issue/PR, batches while busy, follows Closes #N, and ends on close", async () => {
    const { inbox, runs, d, finish, pending } = await setup(3);
    await sendGithub(inbox, "issues", issue("opened", 1));
    await sendGithub(inbox, "issue_comment", comment(1));
    await d.tick();
    expect(runs).toHaveLength(1);
    const [first] = runs;
    expect(first!.resume).toBe(false);
    expect(first!.message).toContain(`loopway thread session ${first!.sessionId}`);
    expect(first!.message.split("already locked for you):\n")[1]!.split("\n")).toHaveLength(2);
    expect(await pending()).toBe(0); // both locked for the session

    // While the run is busy, its new events wait; others' don't.
    await sendGithub(inbox, "issue_comment", comment(1));
    await d.tick();
    expect(runs).toHaveLength(1);
    await finish();
    expect((await sessions())[first!.sessionId]).toMatchObject({ keys: ["a/b#1"], status: "active", started: true });

    // The agent can finish events with the dispatcher's remembered lock tokens.
    const locked = (await runJson("events", "list", inbox.id, "--status", "locked")).data;
    for (const e of locked) expect((await runJson("events", "done", inbox.id, e.id)).status).toBe("processed");

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

    await sendGithub(inbox, "pull_request", pull("closed", 2));
    await d.tick();
    await finish();
    expect((await sessions())[first!.sessionId].status).toBe("ended");
  });

  it("starts a session per unmatched event, up to --max", async () => {
    const { inbox, runs, out, d, finish, pending } = await setup(2);
    await sendGithub(inbox, "issues", issue("opened", 1));
    await sendGithub(inbox, "issues", issue("opened", 2));
    await sendGithub(inbox, "issues", issue("opened", 3));
    await d.tick();
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.sessionId)).size).toBe(2);
    expect(await pending()).toBe(1);
    expect(out.join("\n")).toMatch(/1 event\(s\) waiting: 2 sessions are active/);

    // Closing #1 frees a slot for #3.
    await finish();
    await sendGithub(inbox, "issues", issue("closed", 1));
    await d.tick();
    await finish();
    await d.tick();
    expect(runs.at(-1)!.resume).toBe(false);
    expect(Object.values(await sessions()).map((s: any) => s.keys)).toContainEqual(["a/b#3"]);
    expect(await pending()).toBe(0);
  });

  it("link adds an issue or PR to a session", async () => {
    const { inbox, runs, d, finish } = await setup(3);
    await sendGithub(inbox, "issues", issue("opened", 5));
    await d.tick();
    await finish();
    const id = runs[0]!.sessionId;
    expect(await run("threads", "link", id, "9")).toMatch(/Linked a\/b#9/);
    await run("threads", "link", id, "c/d#3");
    expect((await sessions())[id].keys).toEqual(["a/b#5", "a/b#9", "c/d#3"]);
    await expect(run("threads", "link", randomUUID(), "9")).rejects.toThrow(/No session/);
    await expect(run("threads", "link", id, "nine")).rejects.toThrow(/Expected an issue or PR number/);
  });
});
