import { TEST_INBOX_KEY } from "../src/db/testing.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { clientBuild } from "../scripts/client.js";
import { createApi } from "../src/api.js";
import { SourceRegistry } from "@loopway/sources";
import { sources } from "../src/sources.js";
import { createUser } from "../src/store.js";
import { signSessionToken, verifyToken } from "../src/tokens.js";
import { app, call, db, events, newInbox, newUser, prPayload, SECRET, sendGithub } from "./helpers.js";

// Source-specific webhook tests live in ./sources/<type>.test.ts.

describe("auth", () => {
  it("rejects missing/invalid tokens", async () => {
    expect((await call("GET", "/me")).status).toBe(401);
    expect((await call("GET", "/me", { key: "nope" })).status).toBe(401);
  });
});

describe("sources", () => {
  it("describes every registered source", async () => {
    const r = await call("GET", "/sources", { key: await newUser() });
    expect(r.body.data.map((s: { type: string }) => s.type)).toEqual(sources.types());
    expect(r.body.data.find((s: { type: string }) => s.type === "github")).toMatchObject({
      label: "GitHub",
      secret: { from: "loopway", min_length: 16 },
      webhook_settings: "GitHub → Settings → Webhooks",
    });
    for (const s of r.body.data) {
      // The loopway and schedule sources have no common events: their messages name their own types.
      expect(s.events.length > 0 || ["loopway", "schedule"].includes(s.type)).toBe(true);
      expect(["loopway", "sender", "none"]).toContain(s.secret.from);
    }
  });

  it("refuses to register a type twice", () => {
    const github = sources.get("github")!;
    expect(() => new SourceRegistry([github, github])).toThrow(/registered twice/);
  });
});

describe("inboxes", () => {
  it("creates a github inbox with generated secret and webhook url", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    expect(inbox.config.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(inbox.webhook_url).toBe(`https://loopway.test/api/webhooks/${inbox.id}`);
    const list = await call("GET", "/inboxes", { key });
    expect(list.body.data).toHaveLength(1);
  });
  it("notes when a sender first reaches an inbox, and how the last delivery went", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const before = await call("GET", `/inboxes/${inbox.id}`, { key });
    expect(before.body).toMatchObject({ last_delivery_at: null, last_delivery_outcome: null });

    const ping = await sendGithub(inbox, "ping", { zen: "Keep it logically awesome." });
    expect(ping.status).toBe(200);
    const pinged = await call("GET", `/inboxes/${inbox.id}`, { key });
    expect(pinged.body.last_delivery_at).toEqual(expect.any(String));
    expect(pinged.body.last_delivery_outcome).toBe("ignored:ping");
    expect(
      events.filter((e) => e.event === "inbox_first_delivery" && e.properties?.outcome === "ignored"),
    ).toHaveLength(1);

    const bad = await sendGithub(inbox, "pull_request", prPayload(1), { secret: "not-the-secret-at-all" });
    expect(bad.status).toBe(401);
    expect((await call("GET", `/inboxes/${inbox.id}`, { key })).body.last_delivery_outcome).toBe("rejected:401");

    await sendGithub(inbox, "pull_request", prPayload(1));
    expect((await call("GET", `/inboxes/${inbox.id}`, { key })).body.last_delivery_outcome).toBe("accepted");
    expect(events.filter((e) => e.event === "inbox_first_delivery")).toHaveLength(1);
  });
  it("rejects unknown source types and bad config", async () => {
    const key = await newUser();
    expect((await call("POST", "/inboxes", { key, body: { name: "x", source_type: "nope" } })).status).toBe(400);
    expect(
      (await call("POST", "/inboxes", { key, body: { name: "x", source_type: "github", config: { secret: "short" } } }))
        .status,
    ).toBe(400);
  });
  it("isolates inboxes between users", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const inbox = await newInbox(a);
    expect((await call("GET", `/inboxes/${inbox.id}`, { key: b })).status).toBe(404);
    expect((await call("GET", `/inboxes/${inbox.id}/messages`, { key: b })).status).toBe(404);
  });
  it("patches config, keeping the secret", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const r = await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { events: ["push"] } } });
    expect(r.body.config).toEqual({ events: ["push"], secret_set: true });
    expect((await sendGithub(inbox, "push", {})).status).not.toBe(401);
  });
  it("shows the secret once, on create, and stores it encrypted", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    expect(inbox.config.secret).toBeTruthy();
    const got = await call("GET", `/inboxes/${inbox.id}`, { key });
    expect(got.body.config.secret).toBeUndefined();
    expect(got.body.config.secret_set).toBe(true);
    expect(JSON.stringify(got.body)).not.toContain(inbox.config.secret);
    const listed = await call("GET", "/inboxes", { key });
    expect(JSON.stringify(listed.body)).not.toContain(inbox.config.secret);
    const [row] = await db.query<{ config: object; secret_enc: string }>(
      `SELECT config, secret_enc FROM loopway.inboxes WHERE id = $1`,
      [inbox.id],
    );
    expect(row!.config).not.toHaveProperty("secret");
    expect(row!.secret_enc).toMatch(/^v1\./);
    expect(row!.secret_enc).not.toContain(inbox.config.secret);
  });
  it("can still rename, and set a new secret, when the stored one can't be opened", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    await db.query(`UPDATE loopway.inboxes SET secret_enc = 'v1.bad.bad.bad' WHERE id = $1`, [inbox.id]);
    expect((await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { name: "renamed" } })).status).toBe(200);
    expect((await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { events: ["push"] } } })).status).toBe(
      500,
    );
    const next = "n".repeat(20);
    expect((await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { secret: next } } })).status).toBe(200);
    expect((await sendGithub(inbox, "push", {}, { secret: next })).status).not.toBe(401);
  });
  it("replaces the secret when one is sent", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const next = "n".repeat(20);
    await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { secret: next } } });
    expect((await sendGithub(inbox, "push", {})).status).toBe(401);
    expect((await sendGithub(inbox, "push", {}, { secret: next })).status).not.toBe(401);
  });
});

describe("messages", () => {
  async function setup(n = 3) {
    const key = await newUser();
    const inbox = await newInbox(key);
    for (let i = 1; i <= n; i++) await sendGithub(inbox, "pull_request", prPayload(i));
    const ids = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data.map((e: any) => e.id);
    return { key, inbox, ids: ids as string[], base: `/inboxes/${inbox.id}/messages` };
  }

  it("lists with a type filter and cursor pagination", async () => {
    const { key, base, ids } = await setup(5);
    expect((await call("GET", `${base}?type=com.github.pull_request.*`, { key })).body.data).toHaveLength(5);
    expect((await call("GET", `${base}?type=com.github.push`, { key })).body.data).toHaveLength(0);

    const p1 = await call("GET", `${base}?limit=2`, { key });
    expect(p1.body.data.map((e: any) => e.id)).toEqual(ids.slice(0, 2));
    const p2 = await call("GET", `${base}?limit=2&cursor=${p1.body.next_cursor}`, { key });
    expect(p2.body.data.map((e: any) => e.id)).toEqual(ids.slice(2, 4));
    const p3 = await call("GET", `${base}?limit=2&cursor=${p2.body.next_cursor}`, { key });
    expect(p3.body.next_cursor).toBeNull();
    // An event is just a stored message: no per-event status.
    expect(Object.keys(p1.body.data[0]).sort()).toEqual(["event", "id", "inbox_id", "received_at", "seq", "test"]);
  });

  it("counts an inbox's messages", async () => {
    const { key, inbox } = await setup(2);
    expect((await call("GET", `/inboxes/${inbox.id}`, { key })).body.stats).toEqual({ messages: 2 });
  });

  it("404s on bad ids", async () => {
    const { key, base } = await setup(0);
    expect((await call("GET", `${base}/not-a-uuid`, { key })).status).toBe(404);
    expect((await call("GET", `${base}/${randomUUID()}`, { key })).status).toBe(404);
    expect((await call("GET", `${base}?cursor=nope`, { key })).status).toBe(400);
  });
});

describe("bots", () => {
  /** Ages an inbox's events past the holdback window, as if they'd arrived a minute ago. */
  it("a bot has no lease: those routes are gone and the bot doesn't say who holds it", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    const base = `/bots/${bot.id}`;
    for (const path of ["lease", "release", "cursor", "assign"])
      expect((await call("POST", `${base}/${path}`, { key, body: {} })).status, path).toBe(404);
    const got = (await call("GET", base, { key })).body;
    for (const field of ["lock_token", "locked_until", "leased_until", "runner_id"])
      expect(got).not.toHaveProperty(field);
    expect(got.cursor).toBe(0);
  });
});

describe("session tokens", () => {
  it("rejects expired, tampered and wrongly signed tokens", async () => {
    const { user } = await createUser(db, { name: "Tok" });
    const me = (t: string) => call("GET", "/me", { key: t });
    const { token } = signSessionToken(user.id, SECRET);
    expect((await me(token)).status).toBe(200);
    expect((await me(signSessionToken(user.id, SECRET, Date.now() - 31 * 86400_000).token)).status).toBe(401);
    expect((await me(signSessionToken(user.id, "another-secret").token)).status).toBe(401);
    const [h, , sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: user.id, typ: "session", iat: 0 })).toString("base64url");
    expect((await me(`${h}.${forged}.${sig}`)).status).toBe(401);
    expect(verifyToken(token, SECRET)).toMatchObject({ sub: user.id, typ: "session" });
  });
});

describe("login", () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  const loginApp = () =>
    createApi({
      getDb: async () => db,
      tokenSecret: SECRET,
      inboxSecretKey: TEST_INBOX_KEY,
      sendEmail: async (e) => void sent.push(e),
    });
  const post = (a: ReturnType<typeof createApi>, path: string, body: unknown) =>
    a.request("/api" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const lastCode = () => sent.at(-1)!.text.match(/\b([0-9A-Z]{8})\b/)![1]!;

  it("emails a code and trades it for a session token", async () => {
    const a = loginApp();
    await createUser(db, { name: "Login", email: "login@example.com" });
    expect((await post(a, "/auth/login", { email: "LOGIN@example.com" })).status).toBe(202);
    expect(sent.at(-1)!.to).toBe("login@example.com");

    const res = await post(a, "/auth/verify", { email: "login@example.com", code: lastCode() });
    expect(res.status).toBe(201);
    const { token, expires_at, user } = await res.json();
    expect(user.email).toBe("login@example.com");
    expect(Date.parse(expires_at) - Date.now()).toBeGreaterThan(29 * 86400_000);
    const me = (key: string) => a.request("/api/me", { headers: { authorization: `Bearer ${key}` } });
    expect((await me(token)).status).toBe(200);

    // single use
    expect((await post(a, "/auth/verify", { email: "login@example.com", code: lastCode() })).status).toBe(401);
  });

  it("sends one email per user until the code expires", async () => {
    const a = loginApp();
    await createUser(db, { name: "Spam", email: "spam@example.com" });
    const before = sent.length;
    for (let i = 0; i < 5; i++) expect((await post(a, "/auth/login", { email: "spam@example.com" })).status).toBe(202);
    expect(sent).toHaveLength(before + 1);
    // the one code still works
    expect((await post(a, "/auth/verify", { email: "spam@example.com", code: lastCode() })).status).toBe(201);
    // and once it's used, a new one can be requested
    await post(a, "/auth/login", { email: "spam@example.com" });
    expect(sent).toHaveLength(before + 2);

    await db.query(`UPDATE loopway.login_codes SET expires_at = now() - interval '1 second'`);
    await post(a, "/auth/login", { email: "spam@example.com" });
    expect(sent).toHaveLength(before + 3);
  });

  it("creates a user when an unknown email proves it owns the address", async () => {
    const a = loginApp();
    expect((await post(a, "/auth/login", { email: "New.Person@example.com" })).status).toBe(202);
    expect(sent.at(-1)!.to).toBe("new.person@example.com");
    expect(await db.query(`SELECT 1 FROM loopway.users WHERE email = 'new.person@example.com'`)).toHaveLength(0);

    expect((await post(a, "/auth/verify", { email: "new.person@example.com", code: "ABCD2345" })).status).toBe(401);
    expect(await db.query(`SELECT 1 FROM loopway.users WHERE email = 'new.person@example.com'`)).toHaveLength(0);

    const res = await post(a, "/auth/verify", {
      email: "new.person@example.com",
      code: lastCode(),
      username: "  New-Person ",
    });
    expect(res.status).toBe(201);
    const { token: api_key, user, created } = await res.json();
    expect(created).toBe(true);
    expect(user).toMatchObject({ name: "new-person", email: "new.person@example.com", username: "new-person" });
    expect((await a.request("/api/me", { headers: { authorization: `Bearer ${api_key}` } })).status).toBe(200);
    const orgs = await call("GET", "/orgs", { key: api_key });
    expect(orgs.body.data).toMatchObject([{ slug: "new-person", personal: true }]);
  });

  it("needs a free username to sign up, and keeps the code valid so they can retry", async () => {
    const a = loginApp();
    await newUser("Holder");
    const slug = (await db.query<{ slug: string }>(`SELECT slug FROM loopway.orgs ORDER BY id DESC LIMIT 1`))[0]!.slug;
    await post(a, "/auth/login", { email: "retry@example.com" });
    const code = lastCode();
    const verify = async (username?: string) => {
      const res = await post(a, "/auth/verify", { email: "retry@example.com", code, username });
      return { status: res.status, code: (await res.json()).error?.code };
    };
    const users = () => db.query(`SELECT 1 FROM loopway.users WHERE email = 'retry@example.com'`);

    // More failures than the 5-guess limit: username problems don't spend guesses.
    expect(await verify()).toEqual({ status: 400, code: "username_required" });
    expect(await verify("x")).toEqual({ status: 400, code: "invalid_username" });
    expect(await verify("login")).toEqual({ status: 400, code: "username_reserved" });
    expect(await verify(slug)).toEqual({ status: 409, code: "username_taken" });
    expect(await verify()).toEqual({ status: 400, code: "username_required" });
    expect(await verify("x")).toEqual({ status: 400, code: "invalid_username" });
    expect(await users()).toHaveLength(0);

    expect((await verify("retry-user")).status).toBe(201);
    expect(await users()).toHaveLength(1);
    expect(await db.query(`SELECT 1 FROM loopway.login_codes WHERE email = 'retry@example.com'`)).toHaveLength(0);
  });

  it("checks the code before asking for a username", async () => {
    const a = loginApp();
    await post(a, "/auth/login", { email: "ghost@example.com" });
    const res = await post(a, "/auth/verify", { email: "ghost@example.com", code: "ABCD2345" });
    expect(res.status).toBe(401);
  });

  it("does not report existing users as created", async () => {
    const a = loginApp();
    await createUser(db, { name: "Old", email: "old@example.com" });
    await post(a, "/auth/login", { email: "old@example.com" });
    const { created } = await (await post(a, "/auth/verify", { email: "old@example.com", code: lastCode() })).json();
    expect(created).toBe(false);
  });

  it("locks a code after too many wrong guesses", async () => {
    const a = loginApp();
    await createUser(db, { name: "Guess", email: "guess@example.com" });
    await post(a, "/auth/login", { email: "guess@example.com" });
    const good = lastCode();
    const wrong = good === "00000000" ? "00000001" : "00000000";
    for (let i = 0; i < 5; i++) {
      expect((await post(a, "/auth/verify", { email: "guess@example.com", code: wrong })).status).toBe(401);
    }
    expect((await post(a, "/auth/verify", { email: "guess@example.com", code: good })).status).toBe(401);
  });

  it("rejects malformed input", async () => {
    const a = loginApp();
    expect((await post(a, "/auth/login", { email: "nope" })).status).toBe(400);
    expect((await post(a, "/auth/verify", { email: "a@b.co", code: "abc" })).status).toBe(400);
  });
});

describe("web ui", () => {
  async function get(path: string) {
    const res = await app.request(path);
    return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
  }

  it("serves the page shell without auth", async () => {
    const id = randomUUID();
    const paths = [
      "/",
      "/login",
      "/dashboard",
      "/dashboard/bots",
      "/dashboard/bots/new",
      "/dashboard/inboxes",
      `/dashboard/inboxes/${id}`,
      `/dashboard/bots/${id}`,
      `/dashboard/bots/${id}/prompt`,
      "/acme",
      "/acme/bots",
      "/acme/bots/new",
      "/acme/inboxes",
      `/acme/inboxes/${id}`,
      `/acme/bots/${id}`,
      `/acme/bots/${id}/prompt`,
      `/acme/bots/${id}/threads/${id}`,
    ];
    for (const path of [...paths, `/dashboard/bots/${id}/threads/${id}`]) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.type).toContain("text/html");
      expect(r.text).toContain('<script type="module" src="/app.js">');
      expect(r.text).toContain('<link rel="icon" href="/favicon.ico"');
    }
  });

  it("redirects the old inbox page", async () => {
    const id = randomUUID();
    const res = await app.request(`/dashboard/${id}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/dashboard/inboxes/${id}`);
  });

  it("serves the built bundle without auth", async () => {
    await build({ ...clientBuild, logLevel: "silent" });
    for (const [path, type] of [
      ["/app.js", "text/javascript"],
      ["/app.css", "text/css"],
    ] as const) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.type).toContain(type);
      expect(r.text).toBe(await readFile(`public${path}`, "utf8"));
    }
  });

  it("keeps /api as a bare health check and serves the JSON routes under it", async () => {
    expect(await call("GET", "")).toEqual({ status: 200, body: { ok: true } });
    expect(await call("GET", "/health")).toEqual({ status: 200, body: { ok: true } });
    expect((await call("GET", "/inboxes")).status).toBe(401);
    // The org pages' /:org/bots must not take /api/bots.
    expect((await call("GET", "/bots")).status).toBe(401);
  });

  it("answers 404 on the old top-level API paths", async () => {
    const id = "00000000-0000-7000-8000-000000000000";
    // Not the GETs: a path like /me is the page of an org of that name, which RESERVED_SLUGS keeps anyone from making.
    for (const [method, path] of [
      ["POST", "/auth/login"],
      ["POST", `/webhooks/${id}`],
      ["POST", "/ingest/e/"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});
