import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function sendGithub(inbox: { id: string; config: { secret: string } }, event: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const res = await app.request(`/api/webhooks/${inbox.id}`, {
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

const pr = (n: number) => ({
  action: "opened",
  number: n,
  pull_request: { number: n, body: "" },
  repository: { full_name: "a/b", url: "https://api.github.com/repos/a/b" },
});

async function inboxWithEvents(n: number, name = "gh") {
  const inbox = await runJson("inbox", "create", "--name", name, "--source", "github");
  for (let i = 1; i <= n; i++) await sendGithub(inbox, "pull_request", pr(i));
  return inbox as { id: string; name: string; config: { secret: string } };
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
    await expect(run("inbox", "list")).rejects.toThrow(/Not logged in\. Run `loopway login`/);
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
    expect(inbox.webhook_url).toBe(`${API}/api/webhooks/${inbox.id}`);

    const list = await runJson("inbox", "list");
    expect(list.map((i: any) => i.id)).toEqual([inbox.id]);
    expect(await run("inbox", "ls")).toContain("prs");
  });

  it("sends a test message", async () => {
    await configured();
    const inbox = await runJson("inbox", "create", "--name", "prs", "--source", "github");
    const sent = await runJson("inbox", "test", "prs");
    expect(sent).toMatchObject({ message_id: expect.any(String), seq: expect.any(Number) });
    expect(await run("inbox", "test", inbox.id)).toMatch(/^Sent test message \S+ \(seq \d+\)\./);
    const [message] = (await runJson("messages", "list", inbox.id, "--order", "desc")).data;
    expect(message.test).toBe(true);
    expect(message.event.type).toBe("com.github.pull_request.opened");
  });

  it("explains a test message that can't be sent", async () => {
    await configured();
    await runJson("inbox", "create", "--name", "deploys", "--source", "vercel");
    await expect(run("inbox", "test", "deploys")).rejects.toThrow(/no signing secret yet/);
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
    expect(shown.stats).toEqual({ messages: 2 });
    expect(await run("inbox", "show", "named")).toMatch(/messages\s+2/);
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
    expect(inbox.config).toEqual({ events: ["deployment.error"], secret_set: false });
    await expect(run("inbox", "update", "vc")).rejects.toThrow(/Pass --name, --events, --secret or --schema/);
    const updated = await runJson("inbox", "update", "vc", "--secret", "from-vercel");
    expect(updated.config).toEqual({ events: ["deployment.error"], secret_set: true });
    expect(await run("inbox", "update", inbox.id, "--name", "vercel")).toMatch(/Updated inbox .*vercel/);
  });

  it("creates a loopway inbox with a schema from a file and replaces it with update", async () => {
    await configured();
    const inbox = await runJson("inbox", "create", "--name", "bots", "--source", "loopway");
    expect(inbox.config.schema).toEqual({ type: "object", required: ["type", "id", "data"] });

    const schema = { type: "object", required: ["type", "id", "data"], properties: { type: { const: "ping" } } };
    const file = join(configDir, "schema.json");
    await writeFile(file, JSON.stringify(schema));
    expect((await runJson("inbox", "update", "bots", "--schema", file)).config.schema).toEqual(schema);

    await writeFile(file, JSON.stringify({ type: "object" }));
    await expect(run("inbox", "update", "bots", "--schema", file)).rejects.toThrow(/Invalid request/);
    await expect(run("inbox", "update", "bots", "--schema", join(configDir, "missing.json"))).rejects.toThrow(
      /Could not read a JSON schema/,
    );
  });

  describe("schedule inboxes", () => {
    async function scheduleInbox(name = "clock") {
      const key = await configured();
      const client = new LoopwayClient({ baseUrl: API, apiKey: key, fetch: apiFetch });
      return client.createInbox({
        name,
        source_type: "schedule",
        config: { schedule: { every: "hour" }, messages: [{ type: "standup", message: "Write the standup" }] },
      });
    }

    it("adds, replaces and removes a message type, keeping the others", async () => {
      await scheduleInbox();
      let updated = await runJson("inbox", "update", "clock", "--message", "codex=Check codex = models");
      expect(updated.config.messages).toEqual([
        { type: "standup", message: "Write the standup" },
        { type: "codex", message: "Check codex = models" },
      ]);
      const file = join(configDir, "long.txt");
      await writeFile(file, "line one\nline two\n");
      updated = await runJson("inbox", "update", "clock", "--message-file", `standup=${file}`, "--message", "a=b");
      expect(updated.config.messages).toEqual([
        { type: "standup", message: "line one\nline two" },
        { type: "codex", message: "Check codex = models" },
        { type: "a", message: "b" },
      ]);
      updated = await runJson("inbox", "update", "clock", "--remove-message", "a", "--remove-message", "codex");
      expect(updated.config.messages).toEqual([{ type: "standup", message: "line one\nline two" }]);
    });

    it("changes the schedule and replaces the config from a file", async () => {
      await scheduleInbox();
      let updated = await runJson("inbox", "update", "clock", "--every", "day", "--hour", "9");
      expect(updated.config.schedule).toEqual({ every: "day", hour: 9 });
      updated = await runJson("inbox", "update", "clock", "--hour", "14");
      expect(updated.config.schedule).toEqual({ every: "day", hour: 14 });
      updated = await runJson("inbox", "update", "clock", "--every", "week", "--day", "mon");
      expect(updated.config.schedule).toEqual({ every: "week", day: 1, hour: 14 });
      updated = await runJson("inbox", "update", "clock", "--day", "6", "--hour", "13");
      expect(updated.config.schedule).toEqual({ every: "week", day: 6, hour: 13 });
      updated = await runJson("inbox", "update", "clock", "--every", "hour");
      expect(updated.config.schedule).toEqual({ every: "hour" });

      const file = join(configDir, "schedule.json");
      const config = { schedule: { every: "day", hour: 3 }, messages: [{ type: "only", message: "one" }] };
      await writeFile(file, JSON.stringify(config));
      expect((await runJson("inbox", "update", "clock", "--config", file)).config).toEqual(config);
    });

    it("prints the schedule and messages after an update", async () => {
      await scheduleInbox();
      const out = await run("inbox", "update", "clock", "--message", "codex=Check codex");
      expect(out).toMatch(/schedule\s+every hour/);
      expect(out).toMatch(/Check codex/);
    });

    it("shows a weekly schedule in words", async () => {
      await scheduleInbox();
      await run("inbox", "update", "clock", "--every", "week", "--day", "mon", "--hour", "13");
      expect(await run("inbox", "show", "clock")).toMatch(/schedule\s+weekly on Monday at 13:00 UTC/);
    });

    it("shows the schedule and each message", async () => {
      await scheduleInbox();
      const shown = await run("inbox", "show", "clock");
      expect(shown).toMatch(/schedule\s+every hour/);
      expect(shown).toMatch(/standup/);
      expect(shown).toMatch(/Write the standup/);
    });

    it("rejects bad flags with clear errors", async () => {
      await scheduleInbox();
      await expect(run("inbox", "update", "clock")).rejects.toThrow(/Pass --name, --every/);
      await expect(run("inbox", "update", "clock", "--every", "day")).rejects.toThrow(/needs --hour/);
      await expect(run("inbox", "update", "clock", "--hour", "24")).rejects.toThrow(/0 to 23/);
      await expect(run("inbox", "update", "clock", "--hour", "5")).rejects.toThrow(
        /only applies with --every day or week/,
      );
      await expect(run("inbox", "update", "clock", "--every", "month")).rejects.toThrow(/"hour", "day" or "week"/);
      await expect(run("inbox", "update", "clock", "--every", "week", "--hour", "9")).rejects.toThrow(/needs --day/);
      await expect(run("inbox", "update", "clock", "--every", "week", "--day", "9")).rejects.toThrow(/mon\.\.sun/);
      await expect(run("inbox", "update", "clock", "--every", "week", "--day", "funday")).rejects.toThrow(/mon\.\.sun/);
      await expect(run("inbox", "update", "clock", "--day", "1")).rejects.toThrow(/only applies with --every week/);
      await expect(run("inbox", "update", "clock", "--message", "nope")).rejects.toThrow(/<type>=<value>/);
      await expect(run("inbox", "update", "clock", "--message", "Bad Type=x")).rejects.toThrow(/lowercase/);
      await expect(run("inbox", "update", "clock", "--message", "x=")).rejects.toThrow(/needs some text/);
      await expect(run("inbox", "update", "clock", "--message", `x=${"a".repeat(10_001)}`)).rejects.toThrow(/limit/);
      await expect(run("inbox", "update", "clock", "--remove-message", "nope")).rejects.toThrow(/no message type/);
      await expect(run("inbox", "update", "clock", "--remove-message", "standup")).rejects.toThrow(/at least one/);
      await expect(run("inbox", "update", "clock", "--secret", "s")).rejects.toThrow(/don't apply/);
      await expect(
        run("inbox", "update", "clock", ...Array.from({ length: 20 }, (_, i) => ["--message", `t${i}=x`]).flat()),
      ).rejects.toThrow(/up to 20/);
      await expect(run("inbox", "update", "clock", "--message-file", `a=${join(configDir, "none")}`)).rejects.toThrow(
        /Could not read/,
      );
    });

    it("passes the server's errors through and rejects schedule flags on other sources", async () => {
      await scheduleInbox();
      const file = join(configDir, "bad.json");
      await writeFile(file, JSON.stringify({ schedule: { every: "year" }, messages: [{ type: "a", message: "b" }] }));
      await expect(run("inbox", "update", "clock", "--config", file)).rejects.toThrow(/Invalid request/);

      await runJson("inbox", "create", "--name", "gh", "--source", "github");
      await expect(run("inbox", "update", "gh", "--every", "hour")).rejects.toThrow(/only work on schedule inboxes/);
    });
  });

  describe("creating schedule inboxes", () => {
    it("creates one from flags and shows its schedule", async () => {
      await configured();
      const file = join(configDir, "long.txt");
      await writeFile(file, "line one\nline two\n");
      const out = await run(
        "inbox",
        "create",
        "--name",
        "clock",
        "--source",
        "schedule",
        "--every",
        "day",
        "--hour",
        "9",
        "--message",
        "standup=Write the standup",
        "--message-file",
        `report=${file}`,
      );
      expect(out).toMatch(/schedule\s+daily at 9:00 UTC/);
      expect(out).not.toMatch(/webhook/i);
      const shown = await run("inbox", "show", "clock");
      expect(shown).toMatch(/schedule\s+daily at 9:00 UTC/);
      expect(shown).toContain("Write the standup");
      const inbox = await runJson("inbox", "show", "clock");
      expect(inbox.config.messages).toEqual([
        { type: "standup", message: "Write the standup" },
        { type: "report", message: "line one\nline two" },
      ]);
    });

    it("creates a weekly one with --day", async () => {
      await configured();
      const inbox = await runJson(
        "inbox",
        "create",
        "--name",
        "clock",
        "--source",
        "schedule",
        "--every",
        "week",
        "--day",
        "mon",
        "--hour",
        "13",
        "--message",
        "a=b",
      );
      expect(inbox.config.schedule).toEqual({ every: "week", day: 1, hour: 13 });
    });

    it("creates one from --config, with flags applied on top", async () => {
      await configured();
      const file = join(configDir, "schedule.json");
      await writeFile(file, JSON.stringify({ schedule: { every: "hour" }, messages: [{ type: "a", message: "b" }] }));
      const inbox = await runJson(
        "inbox",
        "create",
        "--name",
        "clock",
        "--source",
        "schedule",
        "--config",
        file,
        "--every",
        "day",
        "--hour",
        "3",
      );
      expect(inbox.config).toEqual({ schedule: { every: "day", hour: 3 }, messages: [{ type: "a", message: "b" }] });
    });

    it("refuses without messages or a schedule, and webhook or schedule flags on the wrong source", async () => {
      await configured();
      const base = ["inbox", "create", "--name", "clock", "--source", "schedule"];
      await expect(run(...base, "--every", "hour")).rejects.toThrow(/at least one message/);
      await expect(run(...base, "--message", "a=b")).rejects.toThrow(/needs --every/);
      await expect(run(...base, "--every", "day", "--message", "a=b")).rejects.toThrow(/needs --hour/);
      await expect(run(...base, "--every", "hour", "--message", "A=b")).rejects.toThrow(/lowercase/);
      await expect(run(...base, "--every", "hour", "--message", "a=b", "--secret", "x")).rejects.toThrow(
        /don't apply to a schedule inbox/,
      );
      await expect(run(...base, "--every", "hour", "--message", "a=b", "--events", "x")).rejects.toThrow(
        /don't apply to a schedule inbox/,
      );
      await expect(run("inbox", "create", "--name", "gh", "--source", "github", "--every", "hour")).rejects.toThrow(
        /only work with --source schedule/,
      );
      expect(await run("inbox", "list")).toContain("No inboxes yet");
    });
  });

  it("creates a granola inbox without a secret and sets it with update", async () => {
    await configured();
    const inbox = await runJson("inbox", "create", "--name", "notes", "--source", "granola");
    expect(inbox.config).toEqual({ events: ["*"], secret_set: false });
    const secret = "whsec_" + Buffer.from("granola-key").toString("base64");
    const updated = await runJson("inbox", "update", "notes", "--secret", secret);
    expect(updated.config).toEqual({ events: ["*"], secret_set: true });
    expect(updated.setup.secret).toBe("set");
  });
});

describe("messages", () => {
  it("list filters, paginates with --all, and get shows one", async () => {
    await configured();
    const inbox = await inboxWithEvents(3);
    const page = await runJson("messages", "list", inbox.id, "--limit", "2");
    expect(page.data).toHaveLength(2);
    expect(page.next_cursor).toBeTruthy();

    const all = await runJson("messages", "list", inbox.id, "--limit", "2", "--all");
    expect(all.data).toHaveLength(3);
    expect(all.next_cursor).toBeNull();
    expect(await run("messages", "list", inbox.id)).toContain("com.github.pull_request.opened");

    const id = all.data[0].id;
    expect((await runJson("messages", "get", inbox.id, id)).event.subject).toBe("1");
    expect(JSON.parse(await run("messages", "get", inbox.id, id, "--data"))).toEqual(pr(1));
  });

  it("rejects bad numbers before calling the API", async () => {
    await configured();
    await expect(run("messages", "list", "x", "--limit", "0")).rejects.toThrow(/positive integer/);
  });
});
