import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { migrate, openDb, type Db } from "../src/db/index.js";
import { createUser } from "../src/store.js";
import { signSessionToken, verifyToken } from "../src/tokens.js";

const SECRET = "test-secret";

let db: Db;
let app: ReturnType<typeof createApi>;

// Runs against in-memory PGlite by default. Set TEST_DATABASE_URL to run against a real Postgres
// (the `loopway` schema in that database is dropped and recreated!).
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  db = await openDb(url ? { databaseUrl: url } : { pgliteDir: "memory://" });
  if (url) {
    await db.query("DROP SCHEMA IF EXISTS loopway CASCADE");
    await migrate(db);
  }
  app = createApi({ getDb: async () => db, publicBaseUrl: "https://loopway.test", tokenSecret: SECRET });
});
afterAll(() => db.close());

// ---------- helpers ----------

async function call(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const res = await app.request(path, {
    method,
    headers: {
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function newUser(name = "Matthew") {
  const { user } = await createUser(db, { name });
  return signSessionToken(user.id, SECRET).token;
}

async function newInbox(key: string, config?: unknown) {
  const r = await call("POST", "/inboxes", { key, body: { name: "gh", source_type: "github", config } });
  expect(r.status).toBe(201);
  return r.body as { id: string; config: { secret: string }; webhook_url: string };
}

function sendGithub(
  inbox: { id: string; config: { secret: string } },
  event: string,
  payload: unknown,
  o: { delivery?: string; secret?: string; form?: boolean } = {},
) {
  const raw = o.form
    ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    : JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", o.secret ?? inbox.config.secret).update(raw).digest("hex");
  return app.request(`/webhooks/${inbox.id}`, {
    method: "POST",
    headers: {
      "content-type": o.form ? "application/x-www-form-urlencoded" : "application/json",
      "x-github-event": event,
      "x-github-delivery": o.delivery ?? randomUUID(),
      "x-hub-signature-256": sig,
    },
    body: raw,
  });
}

const prPayload = (n: number) => ({
  action: "opened",
  number: n,
  pull_request: { updated_at: "2026-10-01T12:00:00Z" },
  repository: { url: "https://api.github.com/repos/craftmill/loopway" },
});

// ---------- tests ----------

describe("auth", () => {
  it("rejects missing/invalid tokens", async () => {
    expect((await call("GET", "/me")).status).toBe(401);
    expect((await call("GET", "/me", { key: "nope" })).status).toBe(401);
  });
});

describe("inboxes", () => {
  it("creates a github inbox with generated secret and webhook url", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    expect(inbox.config.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(inbox.webhook_url).toBe(`https://loopway.test/webhooks/${inbox.id}`);
    const list = await call("GET", "/inboxes", { key });
    expect(list.body.data).toHaveLength(1);
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
    expect((await call("GET", `/inboxes/${inbox.id}/events`, { key: b })).status).toBe(404);
  });
  it("patches config, keeping the secret", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const r = await call("PATCH", `/inboxes/${inbox.id}`, { key, body: { config: { events: ["push"] } } });
    expect(r.body.config).toEqual({ secret: inbox.config.secret, events: ["push"] });
  });
});

describe("github webhooks", () => {
  it("stores a signed event as a CloudEvent", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const res = await sendGithub(inbox, "pull_request", prPayload(7), { delivery: "d-1" });
    expect(res.status).toBe(202);
    const list = await call("GET", `/inboxes/${inbox.id}/events`, { key });
    const e = list.body.data[0];
    expect(e.status).toBe("pending");
    expect(e.event).toMatchObject({
      specversion: "1.0",
      id: "d-1",
      type: "com.github.pull_request.opened",
      source: "https://api.github.com/repos/craftmill/loopway",
      subject: "7",
      time: "2026-10-01T12:00:00.000Z",
      datacontenttype: "application/json",
      data: prPayload(7),
    });
  });

  it("accepts form-encoded payloads", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const res = await sendGithub(inbox, "push", { ref: "refs/heads/main", repository: { url: "u" } }, { form: true });
    expect(res.status).toBe(202);
    const e = (await call("GET", `/inboxes/${inbox.id}/events`, { key })).body.data[0];
    expect(e.event.type).toBe("com.github.push");
    expect(e.event.subject).toBe("refs/heads/main");
  });

  it("rejects bad signatures and unknown inboxes", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    expect((await sendGithub(inbox, "push", {}, { secret: "x".repeat(32) })).status).toBe(401);
    expect((await sendGithub({ ...inbox, id: randomUUID() }, "push", {})).status).toBe(404);
  });

  it("dedupes redeliveries, ignores ping and filtered events", async () => {
    const key = await newUser();
    const inbox = await newInbox(key, { events: ["pull_request"] });
    expect((await sendGithub(inbox, "pull_request", prPayload(1), { delivery: "same" })).status).toBe(202);
    const dup = await sendGithub(inbox, "pull_request", prPayload(1), { delivery: "same" });
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
    expect(await (await sendGithub(inbox, "ping", { zen: "hi" })).json()).toMatchObject({ ignored: true });
    expect(await (await sendGithub(inbox, "push", { ref: "x" })).json()).toMatchObject({ ignored: true });
    expect((await call("GET", `/inboxes/${inbox.id}/events`, { key })).body.data).toHaveLength(1);
  });
});

describe("event processing", () => {
  async function setup(n = 3) {
    const key = await newUser();
    const inbox = await newInbox(key);
    for (let i = 1; i <= n; i++) await sendGithub(inbox, "pull_request", prPayload(i));
    const ids = (await call("GET", `/inboxes/${inbox.id}/events`, { key })).body.data.map((e: any) => e.id);
    return { key, inbox, ids: ids as string[], base: `/inboxes/${inbox.id}/events` };
  }

  it("next claims oldest-first, never hands out the same event twice, 204 when empty", async () => {
    const { key, base, ids } = await setup(3);
    const claims = await Promise.all([1, 2, 3, 4].map(() => call("POST", `${base}/next`, { key })));
    const got = claims.filter((c) => c.status === 200).map((c) => c.body.id);
    expect(got.sort()).toEqual([...ids].sort());
    expect(claims.filter((c) => c.status === 204)).toHaveLength(1);
    expect(claims.find((c) => c.status === 200)!.body.lock.token).toMatch(/^lk_/);
  });

  it("lock / unlock / processed lifecycle", async () => {
    const { key, base, ids } = await setup(1);
    const id = ids[0]!;
    const locked = await call("POST", `${base}/${id}/lock`, { key, body: { ttl_seconds: 60 } });
    expect(locked.status).toBe(200);
    expect(locked.body.status).toBe("locked");
    const token = locked.body.lock.token;

    // someone else can't lock, process, or unlock it
    expect((await call("POST", `${base}/${id}/lock`, { key })).body.error.code).toBe("locked");
    expect((await call("POST", `${base}/${id}/processed`, { key })).status).toBe(409);
    expect((await call("POST", `${base}/${id}/unlock`, { key, body: { lock_token: "lk_x" } })).body.error.code).toBe(
      "lock_mismatch",
    );
    expect((await call("POST", `${base}/next`, { key })).status).toBe(204);

    // holder can renew (same token)
    const renewed = await call("POST", `${base}/${id}/lock`, { key, body: { lock_token: token, ttl_seconds: 120 } });
    expect(renewed.body.lock.token).toBe(token);
    expect(renewed.body.lock_count).toBe(1);

    // unlock → pending again → next picks it up
    expect((await call("POST", `${base}/${id}/unlock`, { key, body: { lock_token: token } })).body.status).toBe(
      "pending",
    );
    const next = await call("POST", `${base}/next`, { key });
    expect(next.body.id).toBe(id);
    expect(next.body.lock_count).toBe(2);

    // process with lock, idempotent after
    const done = await call("POST", `${base}/${id}/processed`, { key, body: { lock_token: next.body.lock.token } });
    expect(done.body.status).toBe("processed");
    expect(done.body.processed_at).toBeTruthy();
    expect((await call("POST", `${base}/${id}/processed`, { key })).status).toBe(200);
    expect((await call("POST", `${base}/${id}/lock`, { key })).body.error.code).toBe("already_processed");
  });

  it("expired locks become claimable", async () => {
    const { key, base, ids } = await setup(1);
    await call("POST", `${base}/${ids[0]}/lock`, { key, body: { ttl_seconds: 1 } });
    await new Promise((r) => setTimeout(r, 1100));
    const next = await call("POST", `${base}/next`, { key });
    expect(next.body.id).toBe(ids[0]);
  });

  it("lists with status/type filters and cursor pagination", async () => {
    const { key, base, ids } = await setup(5);
    await call("POST", `${base}/${ids[0]}/processed`, { key });
    await call("POST", `${base}/${ids[1]}/lock`, { key });

    const pending = await call("GET", `${base}?status=pending`, { key });
    expect(pending.body.data.map((e: any) => e.id)).toEqual(ids.slice(2));
    expect((await call("GET", `${base}?status=processed`, { key })).body.data).toHaveLength(1);
    expect((await call("GET", `${base}?status=locked`, { key })).body.data[0].id).toBe(ids[1]);
    expect((await call("GET", `${base}?type=com.github.pull_request.*`, { key })).body.data).toHaveLength(5);
    expect((await call("GET", `${base}?type=com.github.push`, { key })).body.data).toHaveLength(0);

    const p1 = await call("GET", `${base}?limit=2`, { key });
    expect(p1.body.data.map((e: any) => e.id)).toEqual(ids.slice(0, 2));
    const p2 = await call("GET", `${base}?limit=2&cursor=${p1.body.next_cursor}`, { key });
    expect(p2.body.data.map((e: any) => e.id)).toEqual(ids.slice(2, 4));
    const p3 = await call("GET", `${base}?limit=2&cursor=${p2.body.next_cursor}`, { key });
    expect(p3.body.next_cursor).toBeNull();
    // list responses never leak lock tokens
    expect(JSON.stringify((await call("GET", base, { key })).body)).not.toContain("lk_");
  });

  it("404s on bad ids", async () => {
    const { key, base } = await setup(0);
    expect((await call("GET", `${base}/not-a-uuid`, { key })).status).toBe(404);
    expect((await call("POST", `${base}/${randomUUID()}/lock`, { key })).status).toBe(404);
    expect((await call("GET", `${base}?cursor=nope`, { key })).status).toBe(400);
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
  const loginApp = () => createApi({ getDb: async () => db, tokenSecret: SECRET, sendEmail: async (e) => void sent.push(e) });
  const post = (a: ReturnType<typeof createApi>, path: string, body: unknown) =>
    a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
    const me = (key: string) => a.request("/me", { headers: { authorization: `Bearer ${key}` } });
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
    expect((await db.query(`SELECT 1 FROM loopway.users WHERE email = 'new.person@example.com'`))).toHaveLength(0);

    expect((await post(a, "/auth/verify", { email: "new.person@example.com", code: "ABCD2345" })).status).toBe(401);
    expect((await db.query(`SELECT 1 FROM loopway.users WHERE email = 'new.person@example.com'`))).toHaveLength(0);

    const res = await post(a, "/auth/verify", { email: "new.person@example.com", code: lastCode() });
    expect(res.status).toBe(201);
    const { token: api_key, user, created } = await res.json();
    expect(created).toBe(true);
    expect(user).toMatchObject({ name: "new.person", email: "new.person@example.com" });
    expect((await a.request("/me", { headers: { authorization: `Bearer ${api_key}` } })).status).toBe(200);
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

  it("serves the pages and assets without auth", async () => {
    for (const path of ["/", "/login", "/dashboard", `/dashboard/${randomUUID()}`]) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.type).toContain("text/html");
    }
    expect((await get("/styles.css")).type).toContain("text/css");
    expect((await get("/app.js")).type).toContain("javascript");
  });

  it("keeps /api as a bare health check and leaves the JSON routes alone", async () => {
    expect(await call("GET", "/api")).toEqual({ status: 200, body: { ok: true } });
    expect((await call("GET", "/inboxes")).status).toBe(401);
  });
});
