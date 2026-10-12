import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "@loopway/web/api";
import { openDb, type Db } from "@loopway/web/db";
import { createUser } from "@loopway/web/store";
import { signSessionToken } from "@loopway/web/tokens";
import type { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopwayClient, type Bot, type Message } from "../src/client.js";
import { PRESETS, route as routeWith, type BotRule } from "@loopway/rules";
const GITHUB_THREADS_RULES = PRESETS["github-threads"]!.rules;
const threadPrompt = async () => PRESETS["github-threads"]!.prompt;
import { LIMIT_FALLBACK_MS, LimitWatch, type AgentRun, type RunOutcome } from "../src/bots/agent.js";
import { API_ERROR_BACKOFF_MS, Dispatcher, NETWORK_ERROR_MAX_BACKOFF_MS } from "../src/bots/dispatcher.js";
import { defaultTtl } from "../src/commands/bots-run.js";
import { loadConfig, loadGithubBot, writeConfig } from "../src/config.js";
import { botEnv } from "../src/bots/github.js";
import { UsageError, type Context } from "../src/context.js";
import { createProgram } from "../src/program.js";
import { ensureRunner } from "../src/bots/runner.js";

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
  await writeConfig(configDir, { api_url: API, api_key: key });
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
  it("config writes the URL to ~/.loopway/config.json owner-only, and login then uses it", async () => {
    await expect(run("config", "--url", API, "--key", "lw_x")).rejects.toThrow(/unknown option '--key'/);
    expect(await run("config", "--url", API)).toMatch(/Run `loopway login` next/);
    expect(await savedConfig()).toEqual({ api_url: API });
    expect((await stat(join(configDir, "config.json"))).mode & 0o777).toBe(0o600);

    await createUser(db, { name: "Matthew", email: "config@example.com" });
    await expect(run("login", "--email", "config@example.com")).rejects.toThrow(/--code is required/);
    const code = emails.at(-1)!.text.match(/\b([0-9A-Z]{8})\b/)![1]!;
    await run("login", "--email", "config@example.com", "--code", code);
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

  it("commands fail clearly when not logged in", async () => {
    await configured();
    expect(await run("clear-config")).toMatch(/Removed .*config\.json/);
    await expect(run("inbox", "list")).rejects.toThrow(/Not logged in\. Run `loopway login`/);
  });

  it("loadConfig: env over config.json over defaults; trailing slashes dropped on save", async () => {
    expect(await loadConfig(configDir, {})).toEqual({
      api_url: "https://loopway.craftmill.dev",
      api_key: undefined,
      posthog_host: "https://loopway.craftmill.dev/ingest",
    });
    await writeConfig(configDir, { api_url: "https://file.test/", api_key: "lw_file" });
    expect(await loadConfig(configDir, {})).toEqual({
      api_url: "https://file.test",
      api_key: "lw_file",
      posthog_host: "https://file.test/ingest",
    });
    expect(await loadConfig(configDir, { LOOPWAY_API_URL: "https://env.test", LOOPWAY_API_KEY: "lw_env" })).toEqual({
      api_url: "https://env.test",
      api_key: "lw_env",
      posthog_host: "https://env.test/ingest",
    });
    // The metrics host lives in config.json (which login and config keep), and POSTHOG_HOST overrides it.
    await writeConfig(configDir, { api_url: "https://file.test", posthog_host: "https://eu.i.posthog.com" });
    expect((await loadConfig(configDir, {})).posthog_host).toBe("https://eu.i.posthog.com");
    expect((await loadConfig(configDir, { POSTHOG_HOST: "https://ph.test" })).posthog_host).toBe("https://ph.test");
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

  it("config sets the GitHub bot: all three or none; a flag left out keeps the saved value", async () => {
    const key = await configured();
    await expect(run("config", "--github-token", "ghp_1")).rejects.toThrow(/needs a token, name and email/);
    expect(await savedConfig()).toEqual({ api_url: API, api_key: key });

    const github = { token: "ghp_1", name: "bot", email: "1+bot@users.noreply.github.com" };
    const out = await run(
      "config",
      "--github-token",
      github.token,
      "--github-name",
      github.name,
      "--github-email",
      github.email,
    );
    expect(out).toMatch(/GitHub bot: bot <1\+bot@users\.noreply\.github\.com>/);
    expect(await savedConfig()).toEqual({ api_url: API, api_key: key, github });

    await run("config", "--github-token", "ghp_2");
    expect(await savedConfig()).toEqual({ api_url: API, api_key: key, github: { ...github, token: "ghp_2" } });
    expect(await loadGithubBot(configDir, {})).toEqual({ ...github, token: "ghp_2" });
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
    expect(inbox.config).toEqual({ secret: null, events: ["deployment.error"] });
    await expect(run("inbox", "update", "vc")).rejects.toThrow(/Pass --name, --events, --secret or --schema/);
    const updated = await runJson("inbox", "update", "vc", "--secret", "from-vercel");
    expect(updated.config).toEqual({ secret: "from-vercel", events: ["deployment.error"] });
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

describe("bots", () => {
  /** Ages the inbox's events past the API's holdback window. */
  const settle = (inboxId: string) =>
    db.query(`UPDATE loopway.messages SET received_at = received_at - interval '1 minute' WHERE inbox_id = $1`, [
      inboxId,
    ]);

  it("create → messages shows only events that arrived after the bot was created", async () => {
    await configured();
    const inbox = await inboxWithEvents(2);
    const out = await run(
      "bots",
      "create",
      "--name",
      "dev",
      "--kind",
      "github-threads",
      "--model",
      "sonnet",
      "--inbox",
      inbox.name,
    );
    expect(out).toMatch(/Created bot dev/);
    expect(out).toContain(inbox.name);
    expect(await run("bots", "messages", "dev")).toBe("No new messages.");

    for (const n of [3, 4]) await sendGithub(inbox, "pull_request", pr(n));
    await settle(inbox.id);
    const messages = await runJson("bots", "messages", "dev");
    expect(messages.map((m: any) => m.event.data.number)).toEqual([3, 4]);
    expect(messages[1].seq).toBeGreaterThan(messages[0].seq);
    expect(await run("bots", "messages", "dev", "--limit", "1")).toMatch(/SEQ.*\n.*com\.github\.pull_request\.opened/);
  });

  it("lists, shows, updates and deletes by name or id", async () => {
    await configured();
    const a = await inboxWithEvents(0, "a");
    const b = await inboxWithEvents(0, "b");
    const bot = await runJson(
      "bots",
      "create",
      "--name",
      "dev",
      "--kind",
      "github-threads",
      "--model",
      "sonnet",
      "--inbox",
      a.id,
    );
    expect(bot.inbox_ids).toEqual([a.id]);

    expect(await run("bots", "list")).toMatch(/dev\s+github-threads\s+sonnet\s+a/);
    expect((await runJson("bots", "show", "dev")).id).toBe(bot.id);

    const updated = await runJson("bots", "update", bot.id, "--name", "dev2", "--inbox", "a,b");
    expect(updated.name).toBe("dev2");
    expect(updated.inbox_ids).toEqual([a.id, b.id].sort());
    await expect(run("bots", "update", "dev2")).rejects.toThrow(/--name, --model or --inbox/);
    expect((await runJson("bots", "update", "dev2", "--model", "opus")).model).toBe("opus");

    expect(await run("bots", "delete", "dev2")).toMatch(/Deleted bot/);
    expect(await run("bots", "list")).toMatch(/No bots yet/);
    await expect(run("bots", "show", "dev2")).rejects.toThrow(/No bot with id or name "dev2"/);
  });

  it("lists, prints and edits a bot's versions", async () => {
    await configured();
    const a = await runJson("inbox", "create", "--name", "a", "--source", "github");
    const bot = await runJson(
      "bots",
      "create",
      "--name",
      "dev",
      "--kind",
      "github-threads",
      "--model",
      "sonnet",
      "--inbox",
      a.id,
    );
    expect(await run("bots", "show", "dev", "--prompt")).toBe(await threadPrompt());
    const rules = JSON.parse(await run("bots", "show", "dev", "--rules"));
    expect(rules).toEqual(GITHUB_THREADS_RULES);

    // A new prompt keeps the rules; new rules keep the prompt.
    const promptFile = join(configDir, "prompt.md");
    await writeFile(promptFile, "Be brief.\n");
    expect(await run("bots", "edit", "dev", "--prompt-file", promptFile)).toMatch(/Saved version 2/);
    expect(await run("bots", "show", bot.id, "--prompt")).toBe("Be brief.");
    expect(JSON.parse(await run("bots", "show", "dev", "--rules"))).toEqual(rules);
    const rulesFile = join(configDir, "rules.json");
    await writeFile(rulesFile, JSON.stringify([{ types: ["*"], subject: "data.id" }]));
    expect((await runJson("bots", "edit", "dev", "--rules-file", rulesFile)).version).toBe(3);
    expect(await run("bots", "show", "dev", "--prompt")).toBe("Be brief.");

    const versions = await runJson("bots", "versions", "dev");
    expect(versions.map((v: any) => v.version)).toEqual([3, 2, 1]);
    expect(await run("bots", "versions", "dev")).toMatch(/VERSION.*\n3\s+1\s+/);

    // Rules that don't parse, or no files at all, are refused before anything is saved.
    await writeFile(rulesFile, JSON.stringify([{ types: ["*"], subject: "data.(" }]));
    await expect(run("bots", "edit", "dev", "--rules-file", rulesFile)).rejects.toThrow(/rules\.json/);
    await expect(run("bots", "edit", "dev")).rejects.toThrow(/--prompt-file or --rules-file/);
    expect(await runJson("bots", "versions", "dev")).toHaveLength(3);
  });

  it("checks the kind and inboxes before calling the API", async () => {
    await configured();
    await inboxWithEvents(0, "a");
    await expect(run("bots", "create", "--name", "x", "--kind", "nope", "--inbox", "a")).rejects.toThrow(
      /Allowed choices are github-threads/,
    );
    await expect(run("bots", "create", "--name", "x", "--inbox", "a")).rejects.toThrow(/--kind is required/);
    await expect(run("bots", "create", "--name", "x", "--kind", "github-threads", "--inbox", "a")).rejects.toThrow(
      /--model is required/,
    );
    await expect(
      run("bots", "create", "--name", "x", "--kind", "github-threads", "--model", "sonnet", "--inbox", "zzz"),
    ).rejects.toThrow(/No inbox with id or name "zzz"/);
  });
});

describe("runners", () => {
  it("keeps one id per machine, registers it, and lists what it holds", async () => {
    const key = await configured();
    expect(await run("runners")).toMatch(/No runners yet/);

    const client = new LoopwayClient({ baseUrl: API, apiKey: key, fetch: apiFetch });
    const first = await ensureRunner(configDir, client);
    expect((await ensureRunner(configDir, client)).id).toBe(first.id);
    expect(JSON.parse(await readFile(join(configDir, "runner.json"), "utf8"))).toEqual({ id: first.id });

    const inbox = await inboxWithEvents(0);
    const bot = await runJson(
      "bots",
      "create",
      "--name",
      "dev",
      "--kind",
      "github-threads",
      "--model",
      "sonnet",
      "--inbox",
      inbox.id,
    );
    await client.leaseBot(bot.id, { runner_id: first.id });
    expect(await run("runners")).toMatch(new RegExp(`${first.id}\\s+\\S+\\s+dev\\s+0`));
    expect(await runJson("runners")).toMatchObject([{ id: first.id, bots: [{ id: bot.id, name: "dev" }] }]);
  });

  it("is leased by one bots run at a time, and released when it stops", async () => {
    const key = await configured();
    const client = new LoopwayClient({ baseUrl: API, apiKey: key, fetch: apiFetch });
    const runner = await ensureRunner(configDir, client);
    const inbox = await inboxWithEvents(0);
    const bot = await runJson(
      "bots",
      "create",
      "--name",
      "dev",
      "--kind",
      "github-threads",
      "--model",
      "sonnet",
      "--inbox",
      inbox.id,
    );
    const ctx: Context = { configDir, env: {}, interactive: false, out: () => {}, fetch: apiFetch };

    const first = await Dispatcher.start(ctx, client, [bot], { ttl: 60, runnerId: runner.id });
    expect((await runJson("runners"))[0].leased_until).toEqual(expect.any(String));
    await first.tick();
    // Another process on the same machine (or a copy of runner.json) is refused.
    // A UsageError, which index.ts prints as one `error:` line instead of a stack trace.
    const refused = await Dispatcher.start(ctx, client, [bot], { ttl: 60, runnerId: runner.id }).catch((e) => e);
    expect(refused).toBeInstanceOf(UsageError);
    expect(refused.message).toMatch(/runner is already in use/);
    await first.close();
    expect((await runJson("runners"))[0]).toMatchObject({ leased_until: null, bots: [] });
    const second = await Dispatcher.start(ctx, client, [bot], { ttl: 60, runnerId: runner.id });
    await second.close();
  });

  it("lists a thread's runner, and a released thread has no owner", async () => {
    const key = await configured();
    const client = new LoopwayClient({ baseUrl: API, apiKey: key, fetch: apiFetch });
    const inbox = await inboxWithEvents(1);
    const bot = await runJson(
      "bots",
      "create",
      "--name",
      "dev",
      "--kind",
      "github-threads",
      "--model",
      "sonnet",
      "--inbox",
      inbox.id,
    );
    const runner = await ensureRunner(configDir, client);
    const id = randomUUID();
    const botLease = (await client.leaseBot(bot.id, { runner_id: runner.id })).lease;
    const runnerLease = (await client.leaseRunner(runner.id)).lease;
    const [message] = (await client.listMessages(inbox.id)).data;
    await client.assign(bot.id, {
      lease_token: botLease.token,
      cursor: message!.seq,
      assignments: [{ message_id: message!.id, thread_id: id, add_subjects: ["a/b#1"] }],
    });
    await client.claimThread(bot.id, id, runnerLease.token);
    await client.releaseBot(bot.id, botLease.token);
    expect((await runJson("bots", "threads", "dev"))[0].runner_id).toBe(runner.id);
    expect((await runJson("runners"))[0].threads).toBe(1);
    expect(await run("bots", "threads", "dev")).toContain(runner.name);

    expect(await run("bots", "threads", "release", "dev", id)).toMatch(/Released thread/);
    expect((await runJson("bots", "threads", "dev"))[0].runner_id).toBeNull();
    expect(await run("bots", "threads", "dev")).toMatch(/none/);
  });

  it("moves a subject to another thread, matching the thread by the start of its id", async () => {
    const key = await configured();
    const client = new LoopwayClient({ baseUrl: API, apiKey: key, fetch: apiFetch });
    const inbox = await inboxWithEvents(2);
    const bot = await runJson(
      "bots",
      "create",
      "--name",
      "dev",
      "--kind",
      "github-threads",
      "--model",
      "sonnet",
      "--inbox",
      inbox.id,
    );
    const runner = await ensureRunner(configDir, client);
    const botLease = (await client.leaseBot(bot.id, { runner_id: runner.id })).lease;
    const [m1, m2] = (await client.listMessages(inbox.id)).data;
    const [a, b] = [randomUUID(), randomUUID()];
    await client.assign(bot.id, {
      lease_token: botLease.token,
      cursor: m2!.seq,
      assignments: [
        { message_id: m1!.id, thread_id: a, add_subjects: ["a/b#1"] },
        { message_id: m2!.id, thread_id: b, add_subjects: ["a/b#2"] },
      ],
    });
    await client.releaseBot(bot.id, botLease.token);

    expect(await run("bots", "threads", "move", "dev", "a/b#1", a.slice(0, 8), b.slice(0, 8))).toMatch(
      /Moved a\/b#1 to thread/,
    );
    const threads = await runJson("bots", "threads", "dev");
    expect(threads.find((t: any) => t.id === b).subjects).toEqual(["a/b#1", "a/b#2"]);
    expect(threads.find((t: any) => t.id === a).subjects).toEqual([]);
    await expect(run("bots", "threads", "move", "dev", "a/b#1", a, "zzzz")).rejects.toThrow(/No thread/);
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
  /** The bot's threads on the server, by id. */
  const sessions = async (bot = "dev1") =>
    Object.fromEntries((await runJson("bots", "threads", bot, "--status", "all")).map((t: any) => [t.id, t]));
  const closers: (() => Promise<void>)[] = [];
  const ctxOf = (out: string[]): Context => ({
    configDir,
    env: {},
    interactive: false,
    out: (t) => out.push(t),
    fetch: apiFetch,
  });
  afterEach(async () => void (await Promise.all(closers.splice(0).map((c) => c()))));

  /** Sends a webhook and ages it past the holdback window, so the bot reads it on the next tick. */
  async function send(inbox: { id: string; config: { secret: string } }, event: string, payload: unknown) {
    await sendGithub(inbox, event, payload);
    await db.query(`UPDATE loopway.messages SET received_at = received_at - interval '1 minute' WHERE inbox_id = $1`, [
      inbox.id,
    ]);
  }

  async function setup(max: number, env: NodeJS.ProcessEnv = {}, inboxes = 1) {
    const key = await configured();
    const bots: Bot[] = [];
    const boxes: { id: string; config: { secret: string } }[] = [];
    for (let i = 1; i <= inboxes; i++) {
      const inbox = await runJson("inbox", "create", "--name", `gh${i}`, "--source", "github");
      boxes.push(inbox);
      bots.push(
        await runJson(
          "bots",
          "create",
          "--name",
          `dev${i}`,
          "--kind",
          "github-threads",
          "--model",
          "sonnet",
          "--inbox",
          inbox.id,
        ),
      );
    }
    const runs: AgentRun[] = [];
    const busy: ((outcome: RunOutcome) => void)[] = [];
    const out: string[] = [];
    const ctx: Context = {
      configDir,
      env,
      interactive: false,
      out: (t) => out.push(t),
      fetch: apiFetch,
      // Each run stays "busy" until the test calls finish().
      runAgent: (r) => new Promise((resolve) => (runs.push(r), busy.push(resolve))),
    };
    const client = new LoopwayClient({ baseUrl: API, apiKey: key, fetch: apiFetch });
    const runner = await ensureRunner(configDir, client);
    const d = await Dispatcher.start(ctx, client, bots, { max, ttl: 60, runnerId: runner.id });
    const finish = async (outcome: RunOutcome = { code: 0, delivered: true }) => (
      busy.splice(0).forEach((f) => f(outcome)),
      await d.idle()
    );
    // Let runs still in flight finish before the test ends.
    closers.push(async () => (await finish(), await d.close()));
    const list = async () => (await runJson("messages", "list", boxes[0]!.id, "--all")).data;
    const cursor = async (bot = bots[0]!) => (await runJson("bots", "show", bot.id)).cursor;
    const newest = async () => Math.max(...(await list()).map((e: any) => e.seq));
    return { inbox: boxes[0]!, bots, bot: bots[0]!, client, runner, runs, out, d, finish, list, cursor, newest };
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

  it("routes messages by issue/PR, batches while busy, follows Closes #N, and ends when the session says so", async () => {
    const { inbox, runs, out, d, finish, cursor, newest } = await setup(3);
    await send(inbox, "issues", issue("opened", 1));
    await send(inbox, "issue_comment", comment(1));
    await d.tick();
    expect(runs).toHaveLength(1);
    const [first] = runs;
    expect(first!.resume).toBe(false);
    expect(first!.message).toContain("You are a loopway thread session");
    const lines = first!.message.split("New messages for this thread:\n")[1]!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(
        `^- [0-9a-f-]{36}  com\\.github\\.issues\\.opened  a/b#1  \\(read: loopway messages get ${inbox.id} [0-9a-f-]{36} --data\\)$`,
      ),
    );
    expect(await cursor()).toBe(await newest());

    // While the run is busy, its new messages wait; others' don't.
    await send(inbox, "issue_comment", comment(1));
    await d.tick();
    expect(runs).toHaveLength(1);
    expect((await sessions())[first!.sessionId].waiting).toHaveLength(1);
    await finish();
    expect((await sessions())[first!.sessionId]).toMatchObject({
      subjects: ["a/b#1"],
      status: "active",
      started: true,
    });

    await d.tick(); // the comment that arrived while busy
    expect(runs.map((r) => r.model)).toEqual(runs.map(() => "sonnet"));
    expect(runs[1]).toMatchObject({ sessionId: first!.sessionId, resume: true });
    expect(runs[1]!.message).not.toContain("## 1. Triage");
    expect((await sessions())[first!.sessionId].waiting).toEqual([]);
    await finish();

    // A PR that closes #1 joins that thread.
    await send(inbox, "pull_request", pull("opened", 2, "Adds it.\n\nCloses #1"));
    await d.tick();
    expect(runs[2]!.sessionId).toBe(first!.sessionId);
    await finish();
    expect((await sessions())[first!.sessionId].subjects).toEqual(["a/b#1", "a/b#2"]);

    // A close event alone doesn't end the thread; the session decides, through its end tool.
    await send(inbox, "pull_request", pull("closed", 2));
    await d.tick();
    expect((await mcp(first!.mcpUrl, "tools/call", { name: "end", arguments: {} })).content[0].text).toMatch(/Ended/);
    await finish();
    expect((await sessions())[first!.sessionId].status).toBe("ended");
    expect(out.at(-1)).toMatch(/ended \(exit 0\)/);

    // A later message resumes it and makes it active again.
    await send(inbox, "issue_comment", comment(2));
    await d.tick();
    expect(runs.at(-1)).toMatchObject({ sessionId: first!.sessionId, resume: true });
    expect((await sessions())[first!.sessionId].status).toBe("active");
  });

  it("moves the cursor past what it assigned and records the messages on the thread", async () => {
    const { inbox, runs, d, finish, list, cursor, newest, bot } = await setup(3);
    await send(inbox, "issues", issue("opened", 1));
    await d.tick();
    const [delivered] = await list();
    const id = runs[0]!.sessionId;
    expect(runs[0]!.message).toContain(delivered.id);
    expect(await cursor()).toBe(await newest());
    await finish();

    // Later ticks read nothing new, and the session keeps its record.
    await d.tick();
    expect(runs).toHaveLength(1);
    expect(((await runJson("bots", "threads", "dev1", "--status", "all")) as any[])[0]).toMatchObject({
      id,
      bot_id: bot.id,
      delivered: 1,
      waiting: [],
    });

    // Messages that come back (the cursor didn't move after they were assigned) are skipped.
    await db.query(`UPDATE loopway.bots SET cursor = cursor - 1 WHERE id = $1`, [bot.id]);
    await d.tick();
    expect(runs).toHaveLength(1);
    expect((await sessions())[id]).toMatchObject({ delivered: 1, waiting: [] });
    expect(Object.keys(await sessions())).toEqual([id]);
    expect(await cursor()).toBe(await newest());
  });

  it("never runs more than --max sessions at once, but sessions waiting on their thread don't count", async () => {
    const { inbox, runs, out, d, finish, list } = await setup(2);
    await send(inbox, "issues", issue("opened", 1));
    await send(inbox, "issues", issue("opened", 2));
    await send(inbox, "issues", issue("opened", 3));
    await d.tick();
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.sessionId)).size).toBe(2);
    expect(out.join("\n")).toMatch(/1 session\(s\) waiting: 2 sessions are already running/);
    // The TUI's view: the third issue's message is assigned and waiting, and both sessions are working.
    const state = await d.state();
    expect(state.bots.held.map((b) => b.name)).toEqual(["dev1"]);
    expect(state.waiting).toEqual([
      { id: (await list()).at(-1).id, inbox_id: inbox.id, type: "com.github.issues.opened", subject: "a/b#3" },
    ]);
    expect([...state.running].sort()).toEqual(
      Object.keys(state.threads)
        .filter((id) => !state.threads[id]!.waiting.length)
        .sort(),
    );

    // Once their runs exit, both sessions wait on their threads (still active) without holding a
    // slot, so the queued issue starts right away.
    const freed = d.slotFreed();
    await finish();
    await freed;
    await d.tick();
    expect(runs).toHaveLength(3);
    expect((await d.state()).waiting).toEqual([]);
    expect(Object.values(await sessions()).map((s: any) => s.status)).toEqual(["active", "active", "active"]);

    // With one slot left, new messages for the two waiting threads go oldest first; the other waits.
    await send(inbox, "issue_comment", comment(1));
    await send(inbox, "issue_comment", comment(2));
    const oldest = (await list()).at(-2);
    await d.tick();
    expect(runs).toHaveLength(4);
    expect(runs[3]!.resume).toBe(true);
    expect(runs[3]!.message).toContain(oldest.id);
    expect((await d.state()).waiting).toHaveLength(1);

    // A run exiting frees its slot for the session still waiting.
    await finish();
    await d.tick();
    expect(runs).toHaveLength(5);
    expect((await d.state()).waiting).toEqual([]);
    await finish();
  });

  it("holds every delivery after a run hits the usage limit, then resumes the session where it was", async () => {
    const { inbox, runs, out, d, finish, list } = await setup(3);
    await send(inbox, "issues", issue("opened", 1));
    await d.tick();
    expect(runs).toHaveLength(1);
    const [first] = runs;
    const delivered = (await list()).map((e: any) => e.id);

    // The run stops for the limit after taking its messages: they stay delivered, and nothing starts.
    await finish({ code: 1, delivered: true, limitedUntil: Date.now() + 300 });
    expect(out.join("\n")).toMatch(/hit the usage limit; retrying sessions after/);
    await send(inbox, "issues", issue("opened", 2));
    await send(inbox, "issue_comment", comment(1));
    await d.tick();
    expect(runs).toHaveLength(1);
    const state = await d.state();
    expect(state.running.size).toBe(0);
    expect(state.waiting.map((m) => m.subject)).toEqual(["a/b#2", "a/b#1"]);
    expect(state.threads[first!.sessionId]!.delivered).toBe(delivered.length);
    expect(state.threads[first!.sessionId]!.limited).toBe(true);

    // Once it resets, the session is told to carry on, with the comment that arrived meanwhile.
    await new Promise((r) => setTimeout(r, 350));
    await d.tick();
    expect(out.join("\n")).toMatch(/usage limit reset; resuming sessions/);
    expect(out.join("\n")).toMatch(/resumed \w+ for a\/b#1 \(after the usage limit, 1 message\)/);
    expect(runs).toHaveLength(3);
    const retry = runs.find((r) => r.sessionId === first!.sessionId && r !== first)!;
    expect(retry.resume).toBe(true);
    expect(retry.message).toMatch(/^Your last run stopped because the account hit its usage limit/);
    expect(retry.message).toContain((await list()).find((e: any) => e.event.type.includes("comment")).id);
    for (const id of delivered) expect(retry.message).not.toContain(id);
    const after = await d.state();
    expect(after.waiting).toEqual([]);
    expect(after.threads[first!.sessionId]!.limited).toBe(false);
    await finish();

    // A session the limit stopped with nothing new for it is resumed on its own, with just the note.
    await send(inbox, "issue_comment", comment(2));
    await d.tick();
    expect(runs).toHaveLength(4);
    await finish({ code: 1, delivered: true, limitedUntil: Date.now() + 100 });
    await new Promise((r) => setTimeout(r, 150));
    await d.tick();
    expect(runs).toHaveLength(5);
    expect(runs.at(-1)!.message).toBe(
      "Your last run stopped because the account hit its usage limit. The limit has reset: carry on with the messages you were given, from wherever you got to.",
    );
    await finish();
  });

  it("redelivers a limited run's messages when they never reached the session", async () => {
    const { inbox, runs, out, d, finish, list } = await setup(3);
    await send(inbox, "issues", issue("opened", 1));
    await d.tick();
    expect(runs).toHaveLength(1);
    const [first] = runs;
    const delivered = (await list()).map((e: any) => e.id);

    // The run stops for the limit before taking its messages: they go back to waiting.
    await finish({ code: 1, delivered: false, limitedUntil: Date.now() + 300 });
    expect(out.join("\n")).toMatch(/hit the usage limit; retrying sessions after/);
    await send(inbox, "issues", issue("opened", 2));
    await d.tick();
    expect(runs).toHaveLength(1);
    const state = await d.state();
    expect(state.running.size).toBe(0);
    expect(state.waiting.map((m) => m.subject)).toEqual(["a/b#1", "a/b#2"]);
    expect(state.threads[first!.sessionId]!.delivered).toBe(0);

    // Once it resets, the session is resumed with the same messages, and the new thread starts too.
    await new Promise((r) => setTimeout(r, 350));
    await d.tick();
    expect(out.join("\n")).toMatch(/usage limit reset; resuming sessions/);
    expect(runs).toHaveLength(3);
    const retry = runs.find((r) => r.sessionId === first!.sessionId && r !== first)!;
    expect(retry.resume).toBe(true);
    for (const id of delivered) expect(retry.message).toContain(id);
    expect(retry.message).not.toMatch(/usage limit/);
    expect((await d.state()).waiting).toEqual([]);
    await finish();
  });

  it("LimitWatch: sees our message echoed; a rejected rate_limit_event plus a usage_limit_reached result say when to retry", () => {
    const now = 1_700_000_000_000;
    const rejected = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: now / 1000 + 3600 },
    });
    const limited = JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached" });

    const w = new LimitWatch();
    w.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1 } }));
    w.line("not json (stderr noise)");
    // Tool results and subagent turns are user records too; only our echoed message counts as delivered.
    w.line(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } }));
    w.line(JSON.stringify({ type: "user", parent_tool_use_id: "t1", message: { role: "user", content: "sub" } }));
    expect(w.delivered).toBe(false);
    w.line(JSON.stringify({ type: "user", parent_tool_use_id: null, message: { role: "user", content: "hi" } }));
    expect(w.delivered).toBe(true);
    w.line(JSON.stringify({ type: "result", is_error: true, api_error: "other" }));
    expect(w.limitedUntil(now)).toBeUndefined();
    w.line(rejected);
    expect(w.limitedUntil(now)).toBeUndefined();
    w.line(limited);
    expect(w.limitedUntil(now)).toBe(now + 3600_000);

    // Without a reset time, or with one already past, it falls back to a fixed wait.
    const bare = new LimitWatch();
    bare.line(limited);
    expect(bare.limitedUntil(now)).toBe(now + LIMIT_FALLBACK_MS);
    const stale = new LimitWatch();
    stale.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1 } }));
    stale.line(limited);
    expect(stale.limitedUntil(now)).toBe(now + LIMIT_FALLBACK_MS);
  });

  it("retries a session whose run ended on an API error, with a backoff and a cap", async () => {
    const { inbox, runs, out, d, finish } = await setup(3);
    await send(inbox, "issues", issue("opened", 1));
    await d.tick();
    const [first] = runs;
    const error = "API Error: Overloaded";

    // The first run took its messages, then the network dropped: nothing starts until the backoff passes.
    await finish({ code: 0, delivered: true, apiError: error });
    expect(out.join("\n")).toMatch(/hit an API error .*Overloaded.*retry 1\/3/);
    expect((await d.state()).threads[first!.sessionId]!.interrupted).toBe(true);
    await d.tick();
    expect(runs).toHaveLength(1);

    const real = Date.now;
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    try {
      skew = API_ERROR_BACKOFF_MS + 1000;
      await d.tick();
      expect(runs).toHaveLength(2);
      expect(out.join("\n")).toMatch(/resumed \w+ for a\/b#1 \(after an interruption, 0 messages\)/);
      expect(runs[1]!.resume).toBe(true);
      expect(runs[1]!.message).toMatch(/^Your last run was cut off before it finished/);
      expect((await d.state()).threads[first!.sessionId]!.interrupted).toBe(false);

      await finish({ code: 0, delivered: true, apiError: error });
      expect(out.join("\n")).toMatch(/retry 2\/3/);
      skew += 2 * API_ERROR_BACKOFF_MS + 1000;
      await d.tick();
      expect(runs).toHaveLength(3);
      await finish({ code: 0, delivered: true, apiError: error });
      expect(out.join("\n")).toMatch(/retry 3\/3/);
      skew += 4 * API_ERROR_BACKOFF_MS + 1000;
      await d.tick();
      expect(runs).toHaveLength(4);

      // The cap: the fourth failure in a row is not retried.
      await finish({ code: 0, delivered: true, apiError: error });
      expect(out.join("\n")).toMatch(/giving up after 3 retries/);
      expect((await d.state()).threads[first!.sessionId]!.interrupted).toBe(false);
      skew += 100 * API_ERROR_BACKOFF_MS;
      await d.tick();
      expect(runs).toHaveLength(4);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps retrying a network error, with the backoff capped", async () => {
    const { inbox, runs, out, d, finish } = await setup(3);
    await send(inbox, "issues", issue("opened", 1));
    await d.tick();
    const error = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
    const real = Date.now;
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    try {
      // Well past the retry cap of other errors, and every wait after it is the capped one.
      for (let i = 1; i <= 6; i++) {
        await finish({ code: 0, delivered: true, apiError: error });
        expect(out.join("\n")).toMatch(new RegExp(`retry ${i} after`));
        expect(out.join("\n")).not.toMatch(/giving up/);
        skew += NETWORK_ERROR_MAX_BACKOFF_MS + 1000;
        await d.tick();
        expect(runs).toHaveLength(i + 1);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("redelivers an API-errored run's messages when they never reached the session", async () => {
    const { inbox, runs, d, finish } = await setup(3);
    await send(inbox, "issues", issue("opened", 1));
    await d.tick();
    await finish({ code: 0, delivered: false, apiError: "API Error: offline" });
    expect((await d.state()).waiting.map((m) => m.subject)).toEqual(["a/b#1"]);
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => real() + API_ERROR_BACKOFF_MS + 1000);
    try {
      await d.tick();
      expect(runs).toHaveLength(2);
      expect((await d.state()).waiting).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("LimitWatch: a result that is an API error is reported, unless it is the usage limit", () => {
    const w = new LimitWatch();
    expect(w.apiError()).toBeUndefined();
    w.line(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "API Error: Your computer went to sleep",
      }),
    );
    expect(w.apiError()).toBe("API Error: Your computer went to sleep");
    const limited = new LimitWatch();
    limited.line(JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached", result: "limit" }));
    expect(limited.apiError()).toBeUndefined();
    const fine = new LimitWatch();
    fine.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
    expect(fine.apiError()).toBeUndefined();
  });

  it("runs every bot, sharing --max across them", async () => {
    const { bots, runs, d, finish, cursor, out } = await setup(1, {}, 2);
    const [a, b] = await Promise.all(bots.map((bot) => runJson("inbox", "show", bot.inbox_ids[0]!)));
    await send(a, "issues", issue("opened", 1));
    await send(b, "issues", issue("opened", 1));
    await d.tick();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.message).toContain(`loopway messages get ${a.id} `);
    expect(out.join("\n")).toMatch(/1 session\(s\) waiting/);
    const state = await d.state();
    expect(state.bots.held.map((x) => x.name)).toEqual(["dev1", "dev2"]);
    expect(state.waiting.map((m) => m.inbox_id)).toEqual([b.id]);
    // Both cursors moved: assignment doesn't wait on --max.
    expect(await cursor(bots[0])).toBeGreaterThan(bots[0]!.cursor);
    expect(await cursor(bots[1])).toBeGreaterThan(bots[1]!.cursor);
    expect(Object.keys(await sessions("dev1"))).toHaveLength(1);
    expect(Object.keys(await sessions("dev2"))).toHaveLength(1);

    await finish();
    await d.tick();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.message).toContain(`loopway messages get ${b.id} `);
  });

  it("route: own subject first, then the first closed issue a thread holds; adds only subjects nobody holds", () => {
    const route = (held: ReadonlyMap<string, string>, m: Message) => routeWith(GITHUB_THREADS_RULES, held, m);
    const message = (n: number, body: string) =>
      ({
        id: randomUUID(),
        inbox_id: "in",
        seq: 1,
        received_at: "",
        event: {
          type: "com.github.pull_request.opened",
          data: { number: n, pull_request: { number: n, body }, repository },
        },
      }) as unknown as Message;
    const held = new Map([
      ["a/b#1", "t1"],
      ["a/b#2", "t2"],
    ]);

    // Its own PR is held: that thread wins over the issues it closes; the unheld closed issue is added.
    expect(route(held, message(1, "Closes #2 and fixes #3"))).toEqual({
      thread_id: "t1",
      add_subjects: ["a/b#3"],
      key: "a/b#1",
    });
    // A closing keyword right after a quote or backtick is an example, not a reference.
    expect(route(held, message(1, 'Adds a rule for "Closes #2" and `Fixes #2`.'))).toEqual({
      thread_id: "t1",
      add_subjects: [],
      key: "a/b#1",
    });
    // Otherwise the first closed issue a thread holds; the PR joins it, and what t1 holds stays on t1.
    expect(route(held, message(9, "Closes #5, closes #2, closes #1"))).toEqual({
      thread_id: "t2",
      add_subjects: ["a/b#9", "a/b#5"],
      key: "a/b#9",
    });
    // Nothing held: a new thread with every subject.
    const fresh = route(held, message(7, "Closes #8"))!;
    expect(fresh).toMatchObject({ add_subjects: ["a/b#7", "a/b#8"], key: "a/b#7" });
    expect(["t1", "t2"]).not.toContain(fresh.thread_id);
  });

  it("route: regex_all gives the first group (or the match) of every match, with optional flags", () => {
    const rules = (related: string) => [{ types: ["x.*"], subject: "'s'", related }];
    const route = (related: string) =>
      routeWith(rules(related), new Map(), {
        id: randomUUID(),
        inbox_id: "in",
        seq: 1,
        received_at: "",
        event: { type: "x.y", data: { text: "Ab-1 ab-22" } },
      } as unknown as Message)!.add_subjects;
    expect(route("regex_all(data.text, 'ab-(\\\\d+)')")).toEqual(["s", "22"]);
    expect(route("regex_all(data.text, 'ab-(\\\\d+)', 'i')")).toEqual(["s", "1", "22"]);
    expect(route("regex_all(data.text, '[A-Z]b')")).toEqual(["s", "Ab"]);
    expect(route("regex_all(data.text, '[A-Z]b', 'i')")).toEqual(["s", "Ab", "ab"]);
  });

  it("route: CI joins its PR's thread, a run with no PR and a `future` issue without a thread are dropped", () => {
    const route = (held: ReadonlyMap<string, string>, type: string, data: unknown) =>
      routeWith(GITHUB_THREADS_RULES, held, {
        id: randomUUID(),
        inbox_id: "in",
        seq: 1,
        received_at: "",
        event: { type, data },
      } as unknown as Message);
    const held = new Map([["a/b#1", "t1"]]);
    const run = (prs: { number: number }[]) => ({ repository, workflow_run: { pull_requests: prs } });
    expect(route(held, "com.github.workflow_run.completed", run([{ number: 1 }]))).toEqual({
      thread_id: "t1",
      add_subjects: [],
      key: "a/b#1",
    });
    expect(route(held, "com.github.workflow_run.completed", run([]))).toBeUndefined();
    const future = (n: number) => ({ repository, issue: { number: n, labels: [{ name: "future" }] } });
    expect(route(held, "com.github.issues.opened", future(2))).toBeUndefined();
    expect(route(held, "com.github.issues.opened", future(1))).toMatchObject({ thread_id: "t1" });
    // Pushes have no subject: each is its own thread. Types no rule matches are dropped.
    expect(route(held, "com.github.push", { repository })).toMatchObject({ add_subjects: [], key: undefined });
    expect(route(held, "com.vercel.deployment.created", {})).toBeUndefined();
  });

  it("route: skip moves on to the next rule, attach stops", () => {
    const msg = { id: randomUUID(), inbox_id: "in", seq: 1, received_at: "", event: { type: "x.y", data: {} } };
    const held = new Map([["b", "t2"]]);
    const go = (rules: BotRule[]) => routeWith(rules, held, msg);
    const rule = (subject: string, action?: string) => ({ types: ["x.*"], subject: `'${subject}'`, action });
    // skip falls through; a message nothing attaches is dropped.
    expect(go([rule("a", "'skip'")])).toBeUndefined();
    expect(go([rule("a", "'skip'"), rule("b")])).toMatchObject({ thread_id: "t2", key: "b", add_subjects: [] });
    // attach stops; later rules aren't looked at.
    expect(go([rule("a"), rule("b")])).toMatchObject({ key: "a", add_subjects: ["a"] });
    // `held` says whether a thread holds the subject.
    expect(go([rule("a", "held ? 'attach' : 'skip'"), rule("b", "held ? 'attach' : 'skip'")])).toMatchObject({
      thread_id: "t2",
    });
    expect(() => go([rule("a", "'nope'")])).toThrow(/Unknown rule action/);
  });

  it("picks up a new version of the bot's prompt and rules, and ignores one whose rules don't parse", async () => {
    const { inbox, bot, client, runs, out, d, finish } = await setup(3);
    const current = await client.getBot(bot.id);
    const version = () => current.prompt_version!.version;

    await client.addBotVersion(bot.id, "Be brief.");
    await send(inbox, "issues", issue("opened", 1));
    await d.tick();
    expect(out).toContain(`bot dev1: now on version ${version() + 1}`);
    expect(runs[0]!.message).toContain("Be brief.");
    await finish();

    // The server rejects rules that don't parse.
    await expect(client.addBotVersion(bot.id, "Broken.", [{ types: ["*"], subject: "data.(" }])).rejects.toThrow();
    // One saved before it checked is reported once, and the version before keeps running.
    await db.query(
      `INSERT INTO loopway.bot_versions (bot_id, version, prompt, rules)
       SELECT bot_id, max(version) + 1, 'Broken.', $2::jsonb FROM loopway.bot_versions WHERE bot_id = $1 GROUP BY bot_id`,
      [bot.id, JSON.stringify([{ types: ["*"], subject: "data.(" }])],
    );
    await send(inbox, "issues", issue("opened", 2));
    await d.tick();
    await d.tick();
    expect(out.filter((l) => l.startsWith("bot dev1: ignoring version"))).toHaveLength(1);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.message).toContain("Be brief.");

    // Rules that route everything to one subject: the next two issues share a thread.
    await client.addBotVersion(bot.id, "Same thread.", [{ types: ["*"], subject: '"one"' }]);
    await send(inbox, "issues", issue("opened", 3));
    await send(inbox, "issues", issue("opened", 4));
    await d.tick();
    expect((await client.listThreads(bot.id, "all")).filter((t) => t.subjects.includes("one"))).toHaveLength(1);
  });

  it("leaves threads owned by another runner alone, and shows them as on that runner", async () => {
    const { inbox, bot, client, runs, d } = await setup(3);
    const other = await client.registerRunner({ id: randomUUID(), name: "desktop" });
    // The other runner has a thread on a/b#1.
    await send(inbox, "issue_comment", comment(1));
    const botLease = (await client.leaseBot(bot.id)).lease;
    const otherLease = (await client.leaseRunner(other.id)).lease;
    const [seeded] = (await client.listMessages(inbox.id)).data;
    const threadId = randomUUID();
    await client.assign(bot.id, {
      lease_token: botLease.token,
      cursor: seeded!.seq,
      assignments: [{ message_id: seeded!.id, thread_id: threadId, add_subjects: ["a/b#1"] }],
    });
    await client.claimThread(bot.id, threadId, otherLease.token);
    await client.releaseBot(bot.id, botLease.token);
    await client.patchThread(bot.id, threadId, { lease_token: otherLease.token, started: true });
    await send(inbox, "issue_comment", comment(1));
    await d.tick();
    // The message is assigned to their thread (behind the one that created it), and this runner doesn't deliver it.
    expect(runs).toHaveLength(0);
    const state = await d.state();
    expect(state.waiting).toEqual([]);
    expect(Object.values(state.threads)).toMatchObject([
      { runner_id: other.id, waiting: [{ type: expect.any(String) }, { type: expect.any(String) }] },
    ]);
    expect(state.runners[other.id]).toBe("desktop");
  });

  it("ignores issues labeled future that have no session, but not ones already being worked", async () => {
    const { inbox, runs, d, cursor, newest } = await setup(3);
    const labels = [{ name: "future" }];
    await send(inbox, "issues", { action: "opened", issue: { number: 1, labels }, repository });
    await send(inbox, "issue_comment", { ...comment(1), issue: { number: 1, labels } });
    await send(inbox, "issues", issue("opened", 2));
    await d.tick();
    expect(runs).toHaveLength(1);
    expect(Object.values(await sessions()).map((s: any) => s.subjects)).toEqual([["a/b#2"]]);
    expect(await cursor()).toBe(await newest());

    // A label added mid-work doesn't cut off a thread that already has a session.
    await send(inbox, "issues", { action: "labeled", issue: { number: 2, labels }, repository });
    await d.tick();
    expect((await sessions())[runs[0]!.sessionId].waiting).toHaveLength(1);
  });

  it("skips a bot leased by another runner, and picks it up once released", async () => {
    const { inbox, bot, client, runs, out, d, cursor } = await setup(3);
    const other = (await client.leaseBot(bot.id, { ttl_seconds: 60 })).lease;
    await send(inbox, "issues", issue("opened", 1));
    const before = await cursor();
    await d.tick();
    await d.tick();
    expect(runs).toHaveLength(0);
    expect(await cursor()).toBe(before);
    expect(out.filter((l) => /dev1 is leased by another runner until \d\d:\d\d; skipping/.test(l))).toHaveLength(1);
    expect((await d.state()).bots).toMatchObject({
      held: [],
      skipped: [{ name: "dev1", leased_until: other.expires_at }],
    });

    await client.releaseBot(bot.id, other.token);
    await d.tick();
    expect(runs).toHaveLength(1);
    expect(out.at(-2)).toBe("bot dev1: lease taken");
    expect((await d.state()).bots).toMatchObject({ held: [{ name: "dev1" }], skipped: [] });
    // Now this runner holds it, and keeps it across ticks.
    await expect(client.leaseBot(bot.id)).rejects.toMatchObject({ code: "leased" });
    await d.tick();
    await expect(client.leaseBot(bot.id)).rejects.toMatchObject({ code: "leased" });

    // Closing gives it back right away, and closing again is fine.
    await Promise.all([d.close(), d.close()]);
    closers.splice(0);
    expect((await client.leaseBot(bot.id)).lease.token).not.toBe(other.token);
  });

  it("leases are short by default, and `bots release --force` drops one a dead runner left", async () => {
    expect(defaultTtl(5)).toBe(30);
    expect(defaultTtl(10)).toBe(60);
    expect(defaultTtl(1)).toBe(30);
    const { bot, client, d } = await setup(3);
    const second = await client.registerRunner({ id: randomUUID(), name: "other" });
    const other = await Dispatcher.start(ctxOf([]), client, [bot], { runnerId: second.id });
    closers.push(() => other.close());
    const before = Date.now();
    await other.tick();
    const leased = await client.leaseBot(bot.id).catch((e) => e);
    expect(leased).toMatchObject({ code: "leased" });
    const until = Date.parse(leased.details.expires_at);
    expect(until).toBeGreaterThan(before + 20_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 30_000);

    // That runner "dies": without --force its lease stays, with it the next runner takes the bot right away.
    await expect(run("bots", "release", bot.id)).rejects.toThrow(/Pass --force/);
    await d.tick();
    expect((await d.state()).bots.held).toEqual([]);
    expect(await run("bots", "release", bot.id, "--force")).toMatch(/Released the lease/);
    await d.tick();
    expect((await d.state()).bots).toMatchObject({ held: [{ name: "dev1" }], skipped: [] });
  });

  it("picks up a run a previous runner left cut off, and marks sessions started on init", async () => {
    const { inbox, runs, bot, client, d, finish } = await setup(3);
    await send(inbox, "issues", issue("opened", 7));
    await d.tick();
    const id = runs[0]!.sessionId;
    expect((await sessions())[id]).toMatchObject({ started: false, inflight: [{ type: expect.any(String) }] });
    const runnerId = (await runJson("runners"))[0].id;

    // Claude Code created the session, then the runner died before the run produced a result.
    let started = 0;
    const watch = new LimitWatch(() => started++);
    watch.line(JSON.stringify({ type: "system", subtype: "init" }));
    expect([started, watch.finished]).toEqual([1, false]);
    await mkdir(join(configDir, "threads"), { recursive: true });
    await writeFile(
      join(configDir, "threads", `${id}.log`),
      `{"type":"system","subtype":"init"}\n{"type":"assistant","message":{}}\n`,
    );
    await run("bots", "release", bot.id, "--force");
    await client.forceReleaseRunner(runnerId);

    const runs2: AgentRun[] = [];
    const ctx: Context = {
      configDir,
      env: {},
      interactive: false,
      out: () => {},
      fetch: apiFetch,
      runAgent: async (r) => (runs2.push(r), { code: 0, delivered: true }),
    };
    const d2 = await Dispatcher.start(ctx, client, [bot], { max: 3, ttl: 60, runnerId });
    closers.push(() => d2.close());
    await d2.tick();
    await d2.idle();
    expect(runs2).toHaveLength(1);
    expect(runs2[0]).toMatchObject({ sessionId: id, resume: true });
    expect(runs2[0]!.message).toContain("New messages for this thread");
    expect((await sessions())[id]).toMatchObject({ started: true, waiting: [] });
    expect((await sessions())[id].inflight).toEqual([]);
    await finish();
  });

  it("serves a link tool that routes a PR's messages to the session", async () => {
    const { inbox, runs, d, finish } = await setup(3);
    await send(inbox, "issues", issue("opened", 5));
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
    expect((await sessions())[runs[0]!.sessionId].subjects).toEqual(["a/b#5", "a/b#9", "c/d#3"]);

    // A comment on the linked PR now resumes the session instead of starting a new one.
    await send(inbox, "issue_comment", comment(9));
    await d.tick();
    expect(runs[1]).toMatchObject({ sessionId: runs[0]!.sessionId, resume: true });
  });

  it("runs sessions as the GitHub bot when one is configured", async () => {
    const plain = await setup(3);
    await send(plain.inbox, "issues", issue("opened", 1));
    await plain.d.tick();
    expect(plain.runs[0]!.env.GH_TOKEN).toBeUndefined();

    const bot = {
      LOOPWAY_GITHUB_TOKEN: "ghp_bot",
      LOOPWAY_GITHUB_NAME: "loopway-bot",
      LOOPWAY_GITHUB_EMAIL: "2+loopway-bot@users.noreply.github.com",
    };
    // A second user on the same machine needs a runner of their own.
    await rm(join(configDir, "runner.json"));
    const { inbox, runs, d } = await setup(3, bot);
    await send(inbox, "issues", issue("opened", 2));
    await d.tick();
    expect(runs[0]!.env).toMatchObject({
      GH_TOKEN: "ghp_bot",
      GIT_AUTHOR_NAME: "loopway-bot",
      GIT_COMMITTER_NAME: "loopway-bot",
      GIT_CONFIG_COUNT: "4",
    });
  });

  it("loads the default bot's session prompt", async () => {
    const prompt = await threadPrompt();
    expect(prompt).toContain("You are a loopway thread session");
    expect(prompt).toContain("loopway messages get <inbox> <message> --data");
    expect(prompt).not.toContain("{{");
  });

  it("says how to create a bot when there is none to run", async () => {
    await configured();
    expect(await run("bots", "run", "--no-tui")).toMatch(/No bots to run.*loopway bots create.*--kind github-threads/);
  });
});
