import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "@loopway/web/api";
import { type Db } from "@loopway/web/db";
import { openTestDb, TEST_INBOX_KEY } from "@loopway/web/db/testing";
import { createLoginCode, createUser, setUsername } from "@loopway/web/store";
import { signSessionToken } from "@loopway/web/tokens";
import type { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, writeConfig } from "../src/config.js";
import type { Context } from "../src/context.js";
import { poll, sinceValue } from "../src/commands/read.js";
import { createProgram } from "../src/program.js";
import { LoopwayClient } from "../src/client.js";

const API = "https://loopway.test";
const SECRET = "test-secret";

let db: Db;
let app: ReturnType<typeof createApi>;
let configDir: string;
const emails: { to: string; text: string }[] = [];

// The CLI talks to the real API app in-process; only the network hop is skipped.
// `requests` is every call it made, as "METHOD /path".
const requests: string[] = [];
const apiFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
  return app.request(input, init);
}) as typeof fetch;

beforeAll(async () => {
  db = await openTestDb();
  app = createApi({
    getDb: async () => db,
    publicBaseUrl: API,
    tokenSecret: SECRET,
    inboxSecretKey: TEST_INBOX_KEY,
    sendEmail: async (e) => void emails.push(e),
  });
});
afterAll(() => db.close());

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "loopway-cli-"));
});
afterEach(() => {
  vi.useRealTimers();
  return rm(configDir, { recursive: true, force: true });
});

// ---------- helpers ----------

/** What the last `run` wrote to stderr. */
let notes: string[] = [];

async function run(...args: string[]) {
  const out: string[] = [];
  notes = [];
  const ctx: Context = {
    configDir,
    env: {},
    interactive: false,
    out: (t) => out.push(t),
    err: (t) => notes.push(t),
    fetch: apiFetch,
  };
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

let signups = 0;

/** Signs a new user up through `POST /auth/verify` and saves their session token as the CLI's login. */
async function configured(name = "Matthew") {
  const n = ++signups;
  const email = `cli${n}@example.com`;
  const { code } = await createLoginCode(db, email);
  const res = await app.request("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code, username: `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${n}` }),
  });
  expect(res.status).toBe(201);
  const key = ((await res.json()) as { token: string }).token;
  await writeConfig(configDir, { api_url: API, api_key: key });
  return key;
}

/**
 * Has the server route the inbox's messages to threads now, as a runner's work feed does before it answers: waits out
 * the holdback on messages that are still fresh, then asks for the runner's work, which routes first.
 */
/** An existing user, with a username. */
async function migratedUser(name: string, email: string, username: string) {
  const { user } = await createUser(db, { name, email });
  expect(await setUsername(db, user.id, username)).toMatchObject({ ok: true });
}

// ---------- tests ----------

describe("auth", () => {
  it("config writes the URL to ~/.loopway/config.json owner-only, and login then uses it", async () => {
    await expect(run("config", "update", "--url", API, "--key", "lw_x")).rejects.toThrow(/unknown option '--key'/);
    expect(await run("config", "update", "--url", API)).toMatch(/Run `loopway login` next/);
    expect(await savedConfig()).toEqual({ api_url: API });
    expect((await stat(join(configDir, "config.json"))).mode & 0o777).toBe(0o600);

    await migratedUser("Matthew", "config@example.com", "config");
    await expect(run("login", "--email", "config@example.com")).rejects.toThrow(/--code is required/);
    const code = emails.at(-1)!.text.match(/\b([0-9A-Z]{8})\b/)![1]!;
    await run("login", "--email", "config@example.com", "--code", code);
    expect(await runJson("whoami")).toMatchObject({ name: "Matthew", api_url: API });
  });

  it("login trades an emailed code for a session token and saves it", async () => {
    await migratedUser("Matthew", "m@example.com", "matthew-m");
    await expect(run("login", "--url", API, "--email", "m@example.com")).rejects.toThrow(/--code is required/);
    const code = emails.at(-1)!.text.match(/\b([0-9A-Z]{8})\b/)![1]!;
    expect(await run("login", "--url", API, "--email", "m@example.com", "--code", code)).toMatch(/Logged in/);
    expect((await savedConfig()).api_url).toBe(API);
    expect(await runJson("whoami")).toMatchObject({ name: "Matthew", email: "m@example.com" });
  });

  it("login creates an account for an unknown email once the code is entered", async () => {
    await expect(run("login", "--url", API, "--email", "fresh@example.com")).rejects.toThrow(/--code is required/);
    const code = emails.at(-1)!.text.match(/\b([0-9A-Z]{8})\b/)![1]!;
    expect(
      await run("login", "--url", API, "--email", "fresh@example.com", "--code", code, "--username", "Fresh-1"),
    ).toMatch(/Created your account/);
    expect(await runJson("whoami")).toMatchObject({ name: "fresh-1", email: "fresh@example.com", username: "fresh-1" });
  });

  it("a new account needs a username to sign up; the code survives a refused one, and `username` renames it", async () => {
    await expect(run("login", "--url", API, "--email", "nouser@example.com")).rejects.toThrow(/--code is required/);
    const code = emails.at(-1)!.text.match(/\b([0-9A-Z]{8})\b/)![1]!;
    const login = (...extra: string[]) =>
      run("login", "--url", API, "--email", "nouser@example.com", "--code", code, ...extra);
    await expect(login()).rejects.toThrow(/pass --username/);
    await expect(login("--username", "login")).rejects.toThrow(/reserved/);
    await expect(login("--username", "x")).rejects.toThrow(/at least 2/);
    expect(await savedConfig()).toBeUndefined();
    expect(await db.query(`SELECT 1 FROM loopway.users WHERE email = 'nouser@example.com'`)).toHaveLength(0);

    expect(await login("--username", "nouser")).toMatch(/Created your account/);
    expect(await runJson("whoami")).toMatchObject({ username: "nouser" });
    await run("username", "nouser-2");
    expect(await runJson("whoami")).toMatchObject({ username: "nouser-2" });
  });

  it("login refuses a taken username without using up the code", async () => {
    await configured("Holder");
    const [row] = await db.query<{ slug: string }>(
      `SELECT username AS slug FROM loopway.users WHERE username IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    await expect(run("login", "--url", API, "--email", "taken@example.com")).rejects.toThrow(/--code is required/);
    const code = emails.at(-1)!.text.match(/\b([0-9A-Z]{8})\b/)![1]!;
    const login = (u: string) =>
      run("login", "--url", API, "--email", "taken@example.com", "--code", code, "--username", u);
    await expect(login(row!.slug)).rejects.toThrow(/taken/);
    expect(await login("free-one")).toMatch(/Created your account/);
  });

  it("login rejects a wrong code without saving anything", async () => {
    await createUser(db, { name: "Other", email: "o@example.com" });
    await expect(run("login", "--url", API, "--email", "o@example.com")).rejects.toThrow();
    await expect(run("login", "--url", API, "--email", "o@example.com", "--code", "00000000")).rejects.toThrow(
      /invalid or has expired/,
    );
    expect(await savedConfig()).toBeUndefined();
  });

  it("commands fail clearly when not logged in", async () => {
    await configured();
    expect(await run("clear-config")).toMatch(/Removed .*config\.json/);
    await expect(run("inbox")).rejects.toThrow(/Not logged in\. Run `loopway login`/);
  });

  it("loadConfig: env over config.json over defaults; trailing slashes dropped on save", async () => {
    expect(await loadConfig(configDir, {})).toEqual({
      api_url: "https://loopway.craftmill.dev",
      api_key: undefined,
      posthog_host: "https://a.craftmill.dev/api/ingest",
      auto_update: true,
    });
    await writeConfig(configDir, { api_url: "https://file.test/", api_key: "lw_file" });
    expect(await loadConfig(configDir, {})).toEqual({
      api_url: "https://file.test",
      api_key: "lw_file",
      posthog_host: "https://a.craftmill.dev/api/ingest",
      auto_update: true,
    });
    expect(await loadConfig(configDir, { LOOPWAY_API_URL: "https://env.test", LOOPWAY_API_KEY: "lw_env" })).toEqual({
      api_url: "https://env.test",
      api_key: "lw_env",
      posthog_host: "https://a.craftmill.dev/api/ingest",
      auto_update: true,
    });
    // Self-update is on unless config.json or LOOPWAY_NO_UPDATE turns it off, and `login` keeps the setting.
    await writeConfig(configDir, { api_url: "https://file.test", auto_update: false });
    expect((await loadConfig(configDir, {})).auto_update).toBe(false);
    expect((await loadConfig(configDir, { LOOPWAY_NO_UPDATE: "1" })).auto_update).toBe(false);
    await writeConfig(configDir, { api_url: "https://file.test", auto_update: true });
    expect((await loadConfig(configDir, { LOOPWAY_NO_UPDATE: "1" })).auto_update).toBe(false);
    expect((await loadConfig(configDir, { LOOPWAY_NO_UPDATE: "0" })).auto_update).toBe(true);
    // The metrics host lives in config.json (which login and config keep), and POSTHOG_HOST overrides it.
    await writeConfig(configDir, { api_url: "https://file.test", posthog_host: "https://eu.i.posthog.com" });
    expect((await loadConfig(configDir, {})).posthog_host).toBe("https://eu.i.posthog.com");
    expect((await loadConfig(configDir, { POSTHOG_HOST: "https://ph.test" })).posthog_host).toBe("https://ph.test");
    // A `sandbox` key left by an older CLI is ignored.
    await writeFile(join(configDir, "config.json"), JSON.stringify({ api_url: "https://file.test", sandbox: false }));
    expect(await loadConfig(configDir, {})).not.toHaveProperty("sandbox");
    expect((await loadConfig(configDir, {})).api_url).toBe("https://file.test");
  });

  it("config prints the resolved settings with secrets masked", async () => {
    const key = await configured();
    await run("config", "update", "--posthog-host", "https://eu.i.posthog.com", "--auto-update", "off");
    const out = await run("config");
    expect(out).toMatch(/api_key\s+\*{6}/);
    expect(out).toMatch(/posthog_host\s+https:\/\/eu\.i\.posthog\.com/);
    expect(out).toMatch(/auto_update\s+off/);
    expect(out).not.toContain(key);
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

describe("the inbox", () => {
  it("shows the one URL", async () => {
    await configured();
    const inbox = await runJson("inbox");
    expect(inbox.url).toMatch(/^https:\/\/loopway\.test\/api\/webhooks\/[0-9a-f-]{36}$/);
    expect(await run("inbox")).toContain(inbox.url);
  });
});

describe("sources", () => {
  it("registers GitHub with a generated secret and the gh line to add it", async () => {
    await configured();
    const out = await run("source", "register", "github");
    expect(out).toMatch(/Registered/);
    expect(out).toContain("gh api repos/OWNER/REPO/hooks");
    const [s] = await runJson("source", "list");
    expect(s).toMatchObject({ name: "github", type: "github", secret_set: true });
    expect(s.secret).toBeUndefined();
  });

  it("registers a sender-made secret afterwards, and says deliveries wait for it", async () => {
    await configured();
    const out = await run("source", "register", "linear", "--name", "work");
    expect(out).toContain("loopway source update work --secret <secret>");
    expect((await runJson("source", "show", "work")).secret_set).toBe(false);
    await run("source", "update", "work", "--secret", "lin_secret");
    expect((await runJson("source", "show", "work")).secret_set).toBe(true);
  });

  it("says when a name is taken, and removes by name", async () => {
    await configured();
    await run("source", "register", "github");
    await expect(run("source", "register", "github")).rejects.toThrow(/already have a source named "github"/);
    await run("source", "remove", "github");
    expect(await run("source", "list")).toMatch(/No sources yet/);
    await expect(run("source", "show", "github")).rejects.toThrow(/No source with id or name/);
  });

  it("makes and changes a schedule with its flags", async () => {
    await configured();
    await run(
      "source",
      "register",
      "schedule",
      "--name",
      "clock",
      "--every",
      "day",
      "--hour",
      "7",
      "--message",
      "standup=Write the standup",
    );
    expect(await run("source", "show", "clock")).toMatch(/daily at 7:00 UTC/);
    await run("source", "update", "clock", "--every", "week", "--day", "mon", "--message", "retro=Run the retro");
    const shown = await runJson("source", "show", "clock");
    expect(shown.config.schedule).toEqual({ every: "week", day: 1, hour: 7 });
    expect(shown.config.messages).toHaveLength(2);
    await run("source", "update", "clock", "--remove-message", "retro");
    expect((await runJson("source", "show", "clock")).config.messages).toHaveLength(1);
  });

  it("rejects schedule flags where they don't apply, and bad ones", async () => {
    await configured();
    await expect(run("source", "register", "github", "--every", "day")).rejects.toThrow(/only apply/);
    await expect(run("source", "register", "schedule")).rejects.toThrow(/needs --every/);
    await expect(run("source", "register", "schedule", "--every", "day", "--message", "a=b")).rejects.toThrow(
      /--every day needs --hour/,
    );
    await run("source", "register", "github");
    await expect(run("source", "update", "github", "--every", "day")).rejects.toThrow(/don't apply/);
  });

  it("lists the types", async () => {
    await configured();
    expect(await run("source", "types")).toMatch(/schedule/);
  });
});

describe("messages", () => {
  it("pushes, lists newest first, gets one, and dedupes on --id", async () => {
    await configured();
    expect(await run("push", "build.done", "--subject", "main", "--data", '{"ok":true}', "--id", "b1")).toMatch(
      /Pushed/,
    );
    expect(await run("push", "build.done", "--id", "b1")).toMatch(/Already stored/);
    await run("push", "build.started");
    const list = await runJson("messages", "list");
    expect(list.map((m: { event: { type: string } }) => m.event.type)).toEqual(["build.started", "build.done"]);
    expect(await run("messages", "get", list[1].id, "--data")).toContain('"ok": true');
  });

  it("rejects bad data before calling the API", async () => {
    await configured();
    await expect(run("push", "t", "--data", "{nope")).rejects.toThrow(/must be JSON/);
    await expect(run("push", "t", "--data", "1", "--data-file", "f")).rejects.toThrow(/not both/);
    await expect(run("messages", "list", "--limit", "0")).rejects.toThrow(/positive integer/);
  });
});

describe("tokens", () => {
  it("makes a token that works as LOOPWAY_API_KEY, and revokes it by name", async () => {
    await configured();
    const { token } = await runJson("token", "create", "poller");
    expect(token).toMatch(/^lw_/);
    const client = new LoopwayClient({ baseUrl: API, apiKey: token, fetch: apiFetch });
    expect((await client.me()).username).toBeTruthy();
    expect(await run("token", "list")).toMatch(/poller/);
    await run("token", "revoke", "poller");
    await expect(client.me()).rejects.toThrow(/invalid or expired/);
    await expect(run("token", "revoke", "poller")).rejects.toThrow(/No token/);
  });
});

describe("read and poll", () => {
  /** A reader that appends each message's type to a file, and throws on the type in the FAIL_ON file if there is one. */
  async function writeReader(dir: string, name = "reader.mjs") {
    const path = join(dir, name);
    await writeFile(
      path,
      `import { appendFile, readFile } from "node:fs/promises";
export default async function (msg, ctx) {
  const fail = await readFile(${JSON.stringify(join(dir, "fail-on"))}, "utf8").catch(() => "");
  if (msg.type === fail) throw new Error("no thanks");
  await appendFile(${JSON.stringify(join(dir, "seen"))}, msg.type + "\\n");
  if (msg.type === "echo") await ctx.push({ type: "echoed" });
}
`,
    );
    return path;
  }
  const seen = (dir: string) =>
    readFile(join(dir, "seen"), "utf8").then(
      (t) => t.trim().split("\n"),
      () => [] as string[],
    );
  /** Past the server's read holdback. */
  const age = () => db.query(`UPDATE loopway.inbox_messages SET received_at = received_at - interval '1 minute'`);
  const clear = () => db.query(`DELETE FROM loopway.inbox_messages`);

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "loopway-reader-"));
    await clear();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("starts a new reader from now, then delivers only what's new, once", async () => {
    await configured();
    const reader = await writeReader(dir);
    await run("push", "before");
    await db.query(`UPDATE loopway.inbox_messages SET received_at = received_at - interval '5 minutes'`);
    await run("read", reader);
    expect(notes.join("\n")).toMatch(/starting from now/);
    expect(await seen(dir)).toEqual([]);

    // Time passes: the cursor falls a minute behind, and something arrives in that minute.
    const [file] = await readdir(join(configDir, "cursors"));
    const path = join(configDir, "cursors", file!);
    const cursor = JSON.parse(await readFile(path, "utf8")) as { since: string };
    await writeFile(path, JSON.stringify({ ...cursor, since: String(BigInt(cursor.since) - 60_000_000n) }));
    await run("push", "after");
    await db.query(
      `UPDATE loopway.inbox_messages SET received_at = clock_timestamp() - interval '30 seconds' WHERE ce_type = 'after'`,
    );
    await run("read", reader);
    expect(await seen(dir)).toEqual(["after"]);
    await run("read", reader);
    expect(await seen(dir)).toEqual(["after"]);
    expect(notes.join("\n")).toMatch(/Read 0 messages/);
  });

  it("backfills with --since, and that moves the cursor for later reads", async () => {
    await configured();
    const reader = await writeReader(dir);
    await run("push", "old");
    await run("push", "older");
    await age();
    await run("read", reader, "--since", "2h");
    expect((await seen(dir)).sort()).toEqual(["old", "older"]);
    await run("read", reader);
    expect(await seen(dir)).toHaveLength(2);
    await run("read", reader, "--since", "2h", "--type", "older");
    expect(await seen(dir)).toHaveLength(3);
  });

  it("resets to an exact microsecond from a message's received_at", async () => {
    await configured();
    const reader = await writeReader(dir);
    await run("push", "one");
    await run("push", "two");
    await age();
    const [newest] = await runJson("messages", "list", "--limit", "1");
    await run("read", reader, "--since", newest.received_at);
    expect(await seen(dir)).toEqual(["two"]);
    await run("read", reader, "--since", newest.received_us);
    expect(await seen(dir)).toEqual(["two", "two"]);
  });

  it("stops on a throw, leaves the cursor there, and delivers that message again", async () => {
    await configured();
    const reader = await writeReader(dir);
    await run("push", "a");
    await run("push", "b");
    await run("push", "c");
    await age();
    await writeFile(join(dir, "fail-on"), "b");
    await expect(run("read", reader, "--since", "2h")).rejects.toThrow(/reader failed on message .*no thanks/);
    expect(await seen(dir)).toEqual(["a"]);
    // The next read has no --since: it's the cursor that was left there.
    await expect(run("read", reader)).rejects.toThrow(/no thanks/);
    expect(await seen(dir)).toEqual(["a"]);
    await rm(join(dir, "fail-on"));
    await run("read", reader);
    expect(await seen(dir)).toEqual(["a", "b", "c"]);
  });

  it("walks more than a page", async () => {
    await configured();
    const reader = await writeReader(dir);
    const key = (await savedConfig()).api_key as string;
    const client = new LoopwayClient({ baseUrl: API, apiKey: key, fetch: apiFetch });
    for (let i = 0; i < 105; i++) await client.pushMessage({ type: `m${i}` });
    await age();
    await run("read", reader, "--since", "2h");
    expect(new Set(await seen(dir)).size).toBe(105);
  });

  it("keeps a cursor per reader, per user, per --type", async () => {
    await configured();
    const a = await writeReader(dir, "a.mjs");
    const b = await writeReader(dir, "b.mjs");
    await run("read", a);
    await run("read", b);
    await run("read", a, "--type", "x.*");
    await configured("Other");
    await run("read", a);
    expect(await readdir(join(configDir, "cursors"))).toHaveLength(4);
  });

  it("gives the reader the CloudEvent with received_at, and a push that lands in the same inbox", async () => {
    await configured();
    const reader = join(dir, "r.mjs");
    await writeFile(
      reader,
      `import { writeFile } from "node:fs/promises";
export default async function (msg) { await writeFile(${JSON.stringify(join(dir, "msg.json"))}, JSON.stringify(msg)); }`,
    );
    await run("push", "note", "--subject", "s", "--data", '{"n":1}');
    await age();
    await run("read", reader, "--since", "2h");
    const msg = JSON.parse(await readFile(join(dir, "msg.json"), "utf8"));
    expect(msg).toMatchObject({ specversion: "1.0", type: "note", subject: "s", data: { n: 1 } });
    expect(msg.received_at).toMatch(/\.\d{6}Z$/);
    expect(msg.message_id).toMatch(/^[0-9a-f-]{36}$/);

    const echo = await writeReader(dir, "echo.mjs");
    await run("push", "echo");
    await age();
    await run("read", echo, "--since", "2h", "--type", "echo");
    const types = (await runJson("messages", "list")).map((m: { event: { type: string } }) => m.event.type);
    expect(types).toContain("echoed");
  });

  it("explains a reader it can't use", async () => {
    await configured();
    await expect(run("read", join(dir, "missing.mjs"))).rejects.toThrow(/No reader at/);
    await writeFile(join(dir, "none.mjs"), "export const x = 1;");
    await expect(run("read", join(dir, "none.mjs"))).rejects.toThrow(/must have a default export/);
    await writeFile(join(dir, "broken.mjs"), "this is not javascript");
    await expect(run("read", join(dir, "broken.mjs"))).rejects.toThrow(/Could not load/);
  });

  it("explains a corrupt cursor", async () => {
    await configured();
    const reader = await writeReader(dir);
    await run("read", reader);
    const [file] = await readdir(join(configDir, "cursors"));
    await writeFile(join(configDir, "cursors", file!), "{half");
    await expect(run("read", reader)).rejects.toThrow(/Can't read the cursor/);
    await run("read", reader, "--since", "1h");
  });

  it("leaves the cursor alone when the server refuses a --since", async () => {
    await configured();
    const reader = await writeReader(dir);
    await run("read", reader);
    const [file] = await readdir(join(configDir, "cursors"));
    const before = await readFile(join(configDir, "cursors", file!), "utf8");
    await expect(run("read", reader, "--since", "yesterday")).rejects.toThrow(/since must be/);
    await expect(run("read", reader, "--since", "99999999999d")).rejects.toThrow(/before 1970/);
    expect(await readFile(join(configDir, "cursors", file!), "utf8")).toBe(before);
    await run("read", reader);
  });

  it("warns when a cursor is older than the inbox keeps messages", async () => {
    await configured();
    await run("read", await writeReader(dir), "--since", "16d");
    expect(notes.join("\n")).toMatch(/older than the inbox keeps messages/);
  });

  it("refuses a cursor it can't read, rather than starting over", async () => {
    await configured();
    const reader = await writeReader(dir);
    await run("read", reader);
    const [file] = await readdir(join(configDir, "cursors"));
    const path = join(configDir, "cursors", file!);
    await rm(path);
    await mkdir(path);
    await expect(run("read", reader)).rejects.toThrow(/Can't read the cursor/);
  });

  it("loads compiled CommonJS, and survives a reader throwing what can't be printed", async () => {
    await configured();
    await writeFile(
      join(dir, "cjs.cjs"),
      `Object.defineProperty(exports, "__esModule", { value: true });
exports.default = async function () { throw Object.create(null); };`,
    );
    await run("push", "a");
    await age();
    await expect(run("read", join(dir, "cjs.cjs"), "--since", "2h")).rejects.toThrow(/can't be printed/);
  });

  it("says what happened to the commands 1.0 removed", async () => {
    await configured();
    await expect(run("bots", "run", "--org", "x")).rejects.toThrow(/removed in 1\.0/);
  });

  it("shows other people's control characters as text, not as terminal escapes", async () => {
    await configured();
    await run("push", "evil\u001b]52;c;aGk=\u0007", "--subject", "a\u001b[2Ab");
    const out = await run("messages", "list");
    expect(out).toContain("evil\\x1b]52;c;aGk=\\x07");
    expect(out).toContain("a\\x1b[2Ab");
    const [m] = await runJson("messages", "list");
    expect(await run("messages", "get", m.id)).toContain("\\x1b");
  });

  describe("poll", () => {
    const ctxFor = () => {
      const lines: string[] = [];
      const ctx: Context = {
        configDir,
        env: {},
        interactive: false,
        out: () => {},
        err: (t) => lines.push(t),
        fetch: apiFetch,
      };
      return { ctx, lines };
    };

    it("keeps delivering, retries a failing reader from the same message, and slows when quiet", async () => {
      await configured();
      const reader = await writeReader(dir);
      const { ctx, lines } = ctxFor();
      const stop = new AbortController();
      const waits: number[] = [];
      await run("push", "a");
      await run("push", "b");
      await age();
      await writeFile(join(dir, "fail-on"), "b");
      const steps = [
        async () => {
          expect(await seen(dir)).toEqual(["a"]);
          await rm(join(dir, "fail-on"));
        },
        async () => expect(await seen(dir)).toEqual(["a", "b"]),
        async () => undefined,
        async () => undefined,
        async () => stop.abort(),
      ];
      await poll(ctx, reader, { since: "2h", interval: 2 }, stop.signal, async (ms) => {
        waits.push(ms);
        await steps.shift()?.();
      });
      expect(lines.join("\n")).toMatch(/no thanks/);
      expect(waits).toEqual([4000, 2000, 4000, 8000, 16000]);
    });

    it("waits for a server that isn't up yet", async () => {
      await configured();
      const reader = await writeReader(dir);
      const { ctx, lines } = ctxFor();
      let up = false;
      const flaky = ((input: string | URL | Request, init?: RequestInit) =>
        up ? apiFetch(input, init) : Promise.reject(new Error("refused"))) as typeof fetch;
      const stop = new AbortController();
      let waits = 0;
      await poll({ ...ctx, fetch: flaky }, reader, {}, stop.signal, async () => {
        up = true;
        if (++waits === 2) stop.abort();
      });
      expect(lines.join("\n")).toMatch(/refused/);
      expect(await readdir(join(configDir, "cursors"))).toHaveLength(1);
    });

    it("gives up on what waiting can't fix", async () => {
      await configured();
      const reader = await writeReader(dir);
      const { ctx } = ctxFor();
      await writeConfig(configDir, { api_url: API, api_key: "lw_revoked" });
      await expect(poll(ctx, reader, {}, new AbortController().signal, async () => undefined)).rejects.toThrow(
        /invalid or expired/,
      );
    });

    it("finishes the message in hand when stopped, and saves its cursor", async () => {
      await configured();
      const stop = new AbortController();
      const reader = join(dir, "stop.mjs");
      await writeFile(
        reader,
        `import { appendFile } from "node:fs/promises";
export default async function (msg) {
  await appendFile(${JSON.stringify(join(dir, "seen"))}, msg.type + "\\n");
  globalThis.loopwayTestStop?.();
}`,
      );
      await run("push", "a");
      await run("push", "b");
      await age();
      (globalThis as { loopwayTestStop?: () => void }).loopwayTestStop = () => stop.abort();
      const { ctx } = ctxFor();
      await poll(ctx, reader, { since: "2h" }, stop.signal, async () => undefined);
      delete (globalThis as { loopwayTestStop?: () => void }).loopwayTestStop;
      expect(await seen(dir)).toEqual(["a"]);
      await run("read", reader);
      expect(await seen(dir)).toEqual(["a", "b"]);
    });
  });
});

describe("sinceValue", () => {
  it("turns a duration into a time, and leaves anything else for the API to check", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(sinceValue("2h", now)).toBe("2026-11-04T10:00:00.000Z");
    expect(sinceValue("3d", now)).toBe("2026-11-01T12:00:00.000Z");
    expect(sinceValue("1762300800000000", now)).toBe("1762300800000000");
    expect(sinceValue("2026-11-04T12:00:00.123456Z", now)).toBe("2026-11-04T12:00:00.123456Z");
  });
});
