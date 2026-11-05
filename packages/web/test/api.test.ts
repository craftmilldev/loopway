import { TEST_INBOX_KEY } from "../src/db/testing.js";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { clientBuild } from "../scripts/client.js";
import { createApi } from "../src/api.js";
import { SourceRegistry } from "@loopway/sources";
import { secretBox } from "../src/secrets.js";
import * as store from "../src/store.js";
import { createUser } from "../src/store.js";
import { signSessionToken, verifyToken } from "../src/tokens.js";
import {
  ageMessages,
  app,
  call,
  db,
  newSource,
  newUser,
  prPayload,
  readAll,
  SECRET,
  sendGithub,
  userId,
} from "./helpers.js";

// Source-specific webhook tests live in ./sources/<type>.test.ts.

describe("auth", () => {
  it("rejects missing/invalid tokens", async () => {
    expect((await call("GET", "/me")).status).toBe(401);
    expect((await call("GET", "/me", { key: "nope" })).status).toBe(401);
  });
});

describe("source types", () => {
  it("describes every registered source", async () => {
    const key = await newUser();
    const res = await call("GET", "/source-types", { key });
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { type: string }) => s.type).sort()).toEqual(
      ["github", "granola", "linear", "loopway", "resend", "schedule", "vercel"].sort(),
    );
    expect(res.body.data.find((s: { type: string }) => s.type === "github")).toEqual({
      type: "github",
      label: "GitHub",
      description: expect.any(String),
      secret: { from: "loopway", min_length: 16 },
      webhook_settings: expect.any(String),
    });
  });

  it("refuses to register a type twice", () => {
    const type = { type: "x" } as never;
    expect(() => new SourceRegistry([type, type])).toThrow(/registered twice/);
  });
});

describe("sources", () => {
  it("generates a secret once, and every source shares the user's one inbox URL", async () => {
    const key = await newUser();
    const a = await newSource(key);
    const b = await newSource(key, { type: "github", name: "other-org" });
    expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.webhook_url).toBe(`https://loopway.test/api/webhooks/${a.userId}`);
    expect(b.webhook_url).toBe(a.webhook_url);
    const shown = await call("GET", `/sources/${a.id}`, { key });
    expect(shown.body.secret).toBeUndefined();
    expect(shown.body.secret_set).toBe(true);
    const inbox = await call("GET", "/inbox", { key });
    expect(inbox.body).toEqual({ url: a.webhook_url, sources: 2, messages: 0, retention_days: 14 });
  });

  it("stores the secret encrypted", async () => {
    const key = await newUser();
    const a = await newSource(key);
    const [row] = await db.query<{ secret_enc: string; config: unknown }>(
      `SELECT secret_enc, config FROM loopway.sources WHERE id = $1`,
      [a.id],
    );
    expect(row!.secret_enc).not.toContain(a.secret);
    expect(row!.config).toEqual({});
    expect(secretBox(TEST_INBOX_KEY).open(row!.secret_enc, a.id)).toBe(a.secret);
  });

  it("takes names one at a time, and refuses what a type can't have", async () => {
    const key = await newUser();
    await newSource(key);
    const post = (body: unknown) => call("POST", "/sources", { key, body });
    expect((await post({ type: "github" })).body.error.code).toBe("source_name_taken");
    expect((await post({ type: "nope" })).status).toBe(400);
    expect((await post({ type: "github", name: "x", secret: "short" })).status).toBe(400);
    expect((await post({ type: "github", name: "x", config: {} })).status).toBe(400);
    expect((await post({ type: "granola", secret: "not-a-whsec" })).status).toBe(400);
    expect((await post({ type: "schedule" })).status).toBe(400);
  });

  it("keeps a sender's source without a secret until it's given, and refuses deliveries meanwhile", async () => {
    const key = await newUser();
    const s = await newSource(key, { type: "linear" });
    expect(s.secret).toBeUndefined();
    const raw = JSON.stringify({ type: "Issue", action: "create", data: { id: "i" } });
    const send = () =>
      app.request(`/api/webhooks/${s.userId}`, {
        method: "POST",
        headers: {
          "linear-signature": createHmac("sha256", "lin-secret").update(raw).digest("hex"),
          "linear-delivery": "d-1",
        },
        body: raw,
      });
    expect((await send()).status).toBe(401);
    const patched = await call("PATCH", `/sources/${s.id}`, { key, body: { secret: "lin-secret" } });
    expect(patched.body.secret_set).toBe(true);
    expect((await send()).status).toBe(202);
  });

  it("renames, and refuses a name that's taken", async () => {
    const key = await newUser();
    const a = await newSource(key);
    await newSource(key, { type: "github", name: "b" });
    expect((await call("PATCH", `/sources/${a.id}`, { key, body: { name: "a" } })).body.name).toBe("a");
    expect((await call("PATCH", `/sources/${a.id}`, { key, body: { name: "b" } })).status).toBe(409);
  });

  it("stops accepting a sender once its source is removed, and keeps what it sent", async () => {
    const key = await newUser();
    const a = await newSource(key);
    expect((await sendGithub(a, "pull_request", prPayload(1))).status).toBe(202);
    expect((await call("DELETE", `/sources/${a.id}`, { key })).status).toBe(204);
    expect((await sendGithub(a, "pull_request", prPayload(2))).status).toBe(401);
    expect((await readAll(key)).map((m) => m.source_id)).toEqual([null]);
  });

  it("caps how many a user can have", async () => {
    const key = await newUser();
    const id = await userId(key);
    for (let i = 0; i < store.MAX_SOURCES; i++) {
      await store.createSource(db, { id: randomUUID(), userId: id, name: `s${i}`, sourceType: "github", config: {} });
    }
    const res = await call("POST", "/sources", { key, body: { type: "github" } });
    expect(res.body.error.code).toBe("too_many_sources");
  });
});

describe("the inbox URL", () => {
  it("is a 404 for a user who doesn't exist", async () => {
    expect((await sendGithub({ userId: randomUUID(), secret: "x".repeat(16) }, "push", {})).status).toBe(404);
    expect((await app.request("/api/webhooks/nope", { method: "POST" })).status).toBe(404);
  });

  it("refuses a delivery no source verifies, and stores nothing", async () => {
    const key = await newUser();
    const a = await newSource(key);
    const res = await sendGithub(a, "pull_request", prPayload(1), { secret: "wrong-secret-wrong" });
    expect(res.status).toBe(401);
    const anon = await app.request(`/api/webhooks/${a.userId}`, { method: "POST", body: "{}" });
    expect(anon.status).toBe(401);
    expect(await readAll(key)).toEqual([]);
    // The URL is public, so a refused delivery says nothing about the source, and can't change what's recorded on it.
    expect((await call("GET", `/sources/${a.id}`, { key })).body.last_delivery_at).toBeNull();
  });

  it("tries each secret of a type, and credits the one that verified", async () => {
    const key = await newUser();
    const a = await newSource(key, { type: "github", name: "org-a" });
    const b = await newSource(key, { type: "github", name: "org-b" });
    expect((await sendGithub(b, "pull_request", prPayload(1))).status).toBe(202);
    expect((await sendGithub(a, "pull_request", prPayload(2))).status).toBe(202);
    expect((await readAll(key)).map((m) => m.source_id)).toEqual([b.id, a.id]);
    for (const s of [a, b]) {
      expect((await call("GET", `/sources/${s.id}`, { key })).body.last_delivery_outcome).toBe("accepted");
    }
  });

  it("tells senders apart by how they sign", async () => {
    const key = await newUser();
    const gh = await newSource(key);
    const push = await newSource(key, { type: "loopway" });
    expect((await sendGithub(gh, "pull_request", prPayload(1))).status).toBe(202);
    const res = await app.request(`/api/webhooks/${gh.userId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${push.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "build.done", id: 1, data: {} }),
    });
    expect(res.status).toBe(202);
    expect((await readAll(key)).map((m) => m.source_id)).toEqual([gh.id, push.id]);
  });

  it("keeps one user's secret from opening another's inbox", async () => {
    const a = await newSource(await newUser("a"));
    const bKey = await newUser("b");
    const b = await newSource(bKey);
    const res = await sendGithub({ userId: b.userId, secret: a.secret }, "pull_request", prPayload(1));
    expect(res.status).toBe(401);
    expect(await readAll(bKey)).toEqual([]);
  });

  it("dedupes a redelivery, per user", async () => {
    const key = await newUser();
    const a = await newSource(key);
    const first = await sendGithub(a, "pull_request", prPayload(1), { delivery: "d-1" });
    const again = await sendGithub(a, "pull_request", prPayload(1), { delivery: "d-1" });
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true, id: ((await first.json()) as { id: string }).id });
    expect(await readAll(key)).toHaveLength(1);
    const other = await newSource(await newUser("other"));
    expect((await sendGithub(other, "pull_request", prPayload(1), { delivery: "d-1" })).status).toBe(202);
  });
});

describe("reading messages", () => {
  async function seeded(n: number) {
    const key = await newUser();
    const a = await newSource(key);
    for (let i = 1; i <= n; i++) expect((await sendGithub(a, "pull_request", prPayload(i))).status).toBe(202);
    await ageMessages();
    return { key, a };
  }
  const read = (key: string, qs: string) => call("GET", `/messages?${qs}`, { key });

  it("gives microsecond timestamps, as text a JS Date can't round", async () => {
    const { key } = await seeded(1);
    const [m] = (await read(key, "since=0")).body.data;
    expect(m.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(m.received_us).toMatch(/^\d{16}$/);
    const [row] = await db.query<{ same: boolean }>(
      `SELECT received_at = $2::text::timestamptz AS same FROM loopway.inbox_messages WHERE id = $1`,
      [m.id, m.received_at],
    );
    expect(row!.same).toBe(true);
    // Back to it from either form of the time, inclusively.
    expect((await read(key, `since=${m.received_us}`)).body.data[0].id).toBe(m.id);
    expect((await read(key, `since=${encodeURIComponent(m.received_at)}`)).body.data[0].id).toBe(m.id);
  });

  it("walks every message once, in order, across pages", async () => {
    const { key } = await seeded(5);
    const seen: string[] = [];
    let qs = "since=0&limit=2";
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(5);
      const { data, next_since, next_after, has_more } = (await read(key, qs)).body;
      seen.push(...data.map((m: { id: string }) => m.id));
      if (!has_more) break;
      qs = `since=${next_since}&after=${next_after}&limit=2`;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(
      (
        await db.query<{ id: string }>(
          `SELECT m.id FROM loopway.inbox_messages m WHERE m.id = ANY($1::uuid[]) ORDER BY received_at, id`,
          [seen],
        )
      ).map((r) => r.id),
    );
  });

  it("makes progress through a page of ties in one microsecond", async () => {
    const { key } = await seeded(5);
    const id = await userId(key);
    await db.query(`UPDATE loopway.inbox_messages SET received_at = now() - interval '1 minute' WHERE user_id = $1`, [
      id,
    ]);
    const seen: string[] = [];
    let qs = "since=0&limit=2";
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(5);
      const { data, next_since, next_after, has_more } = (await read(key, qs)).body;
      seen.push(...data.map((m: { id: string }) => m.id));
      if (!has_more) break;
      qs = `since=${next_since}&after=${next_after}&limit=2`;
    }
    expect(new Set(seen).size).toBe(5);
  });

  it("holds back the newest messages, so one still committing can't be skipped", async () => {
    const key = await newUser();
    const a = await newSource(key);
    await sendGithub(a, "pull_request", prPayload(1));
    const page = (await read(key, "since=0")).body;
    expect(page.data).toEqual([]);
    // The cursor stays behind the message, so it comes as soon as it's old enough.
    await db.query(
      `UPDATE loopway.inbox_messages SET received_at = clock_timestamp() - interval '10 seconds' WHERE user_id = $1`,
      [a.userId],
    );
    expect(BigInt(page.next_since)).toBeLessThanOrEqual(BigInt(Date.now()) * 1000n);
    expect((await read(key, "since=0")).body.data).toHaveLength(1);
  });

  it("starts a new reader at the head with since=now", async () => {
    const { key } = await seeded(2);
    const start = (await read(key, "since=now")).body;
    expect(start.data).toEqual([]);
    expect(start.next_since).toMatch(/^\d{16}$/);
    expect((await read(key, `since=${start.next_since}`)).body.data).toEqual([]);
  });

  it("moves a caught-up cursor to the head, and doesn't move one set in the future", async () => {
    const { key } = await seeded(1);
    const page = (await read(key, "since=0")).body;
    expect(page.next_after).toBeNull();
    expect(BigInt(page.next_since)).toBeGreaterThan(BigInt(page.data[0].received_us));
    const future = String(BigInt(Date.now() + 86_400_000) * 1000n);
    expect((await read(key, `since=${future}`)).body.next_since).toBe(future);
  });

  it("drops a message from every read at 14 days, before the purge has run", async () => {
    const { key } = await seeded(2);
    const id = await userId(key);
    const [old] = await db.query<{ id: string }>(
      `UPDATE loopway.inbox_messages SET received_at = now() - interval '14 days 1 second'
       WHERE id = (SELECT id FROM loopway.inbox_messages WHERE user_id = $1 ORDER BY id LIMIT 1) RETURNING id`,
      [id],
    );
    expect((await read(key, "since=0")).body.data).toHaveLength(1);
    expect((await read(key, "order=desc")).body.data).toHaveLength(1);
    expect((await call("GET", `/messages/${old!.id}`, { key })).status).toBe(404);
    expect((await call("GET", "/inbox", { key })).body.messages).toBe(1);
  });

  it("filters by type, exact or by prefix", async () => {
    const { key } = await seeded(1);
    await call("POST", "/messages", { key, body: { type: "build.done" } });
    await ageMessages();
    const types = async (qs: string) =>
      (await read(key, qs)).body.data.map((m: { event: { type: string } }) => m.event.type);
    expect(await types("since=0&type=build.done")).toEqual(["build.done"]);
    expect(await types("since=0&type=com.github.*")).toEqual(["com.github.pull_request.opened"]);
    expect(await types("since=0&type=com.github")).toEqual([]);
  });

  it("shows the newest first with order=desc, which has no cursor", async () => {
    const { key } = await seeded(3);
    const page = (await read(key, "order=desc&limit=2")).body;
    expect(page.data).toHaveLength(2);
    expect(BigInt(page.data[0].received_us)).toBeGreaterThan(BigInt(page.data[1].received_us));
    expect((await read(key, "order=desc&since=0")).status).toBe(400);
  });

  it("refuses a since or after it can't use", async () => {
    const { key } = await seeded(1);
    expect((await read(key, "since=yesterday")).body.error.code).toBe("invalid_since");
    expect((await read(key, "since=2026-13-45T00:00:00Z")).status).toBe(400);
    expect((await read(key, "since=99999999999999999999")).status).toBe(400);
    expect((await read(key, "after=not-a-uuid&since=0")).status).toBe(400);
    expect((await read(key, `after=${randomUUID()}`)).status).toBe(400);
    expect((await read(key, "since=0&limit=101")).status).toBe(400);
  });

  it("404s on a message that isn't there", async () => {
    const key = await newUser();
    expect((await call("GET", `/messages/${randomUUID()}`, { key })).status).toBe(404);
    expect((await call("GET", "/messages/nope", { key })).status).toBe(404);
  });
});

describe("a slow insert", () => {
  // The bug a timestamp cursor invites: a row is stamped when its insert runs and visible when it commits, so a reader
  // can read past a stamp while that row is still on its way. This holds a real insert open across a real read.
  it("isn't skipped by a reader that reads while it commits", async () => {
    const key = await newUser();
    const id = await userId(key);
    const cursor = (await call("GET", "/messages?since=now", { key })).body.next_since as string;
    let release!: () => void;
    let inserted!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const stamped = new Promise<void>((done) => (inserted = done));
    const slow = db.transaction(async (tx) => {
      await store.insertMessage(tx as never, id, null, {
        specversion: "1.0",
        id: "slow",
        source: "urn:test",
        type: "slow",
      });
      inserted();
      await held;
    });
    await stamped;
    // A newer message that commits first: a read with no holdback would move the cursor past the slow one.
    await call("POST", "/messages", { key, body: { type: "fast" } });
    const during = (await call("GET", `/messages?since=${cursor}`, { key })).body;
    expect(during.data).toEqual([]);
    expect(BigInt(during.next_since) - BigInt(cursor)).toBeLessThan(5_000_000n);
    release();
    await slow;

    await db.query(
      `UPDATE loopway.inbox_messages SET received_at = received_at - interval '1 minute' WHERE user_id = $1`,
      [id],
    );
    const after = (await call("GET", `/messages?since=${BigInt(cursor) - 120_000_000n}`, { key })).body;
    expect(after.data.map((m: { event: { type: string } }) => m.event.type).sort()).toEqual(["fast", "slow"]);
  });

  it("stores a message whose duplicate the purge takes mid-insert", async () => {
    const key = await newUser();
    const id = await userId(key);
    const ce = { specversion: "1.0", id: "again", source: "urn:test", type: "t" } as const;
    const first = await store.insertMessage(db, id, null, ce);
    expect((await store.insertMessage(db, id, null, ce)).duplicate).toBe(true);
    await db.query(`DELETE FROM loopway.inbox_messages WHERE id = $1`, [first.id]);
    expect((await store.insertMessage(db, id, null, ce)).duplicate).toBe(false);
  });
});

describe("pushing messages", () => {
  it("stores a CloudEvent, and dedupes on the id it's given", async () => {
    const key = await newUser();
    const body = { type: "build.done", subject: "main", id: "b-1", data: { ok: true } };
    const first = await call("POST", "/messages", { key, body });
    const again = await call("POST", "/messages", { key, body });
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ id: first.body.id, duplicate: true });
    const [m] = await readAll(key);
    expect(m!.event).toMatchObject({
      specversion: "1.0",
      id: "b-1",
      source: "urn:loopway:push",
      type: "build.done",
      subject: "main",
      data: { ok: true },
    });
    expect(m!.source_id).toBeNull();
  });

  it("makes every push its own message without an id", async () => {
    const key = await newUser();
    await call("POST", "/messages", { key, body: { type: "t" } });
    await call("POST", "/messages", { key, body: { type: "t" } });
    expect(await readAll(key)).toHaveLength(2);
  });

  it("refuses a bad message", async () => {
    const key = await newUser();
    const post = (body: unknown) => call("POST", "/messages", { key, body });
    expect((await post({})).status).toBe(400);
    expect((await post({ type: "t", extra: 1 })).status).toBe(400);
    expect((await post({ type: "t", data: "x".repeat(1024 * 1024 + 1) })).body.error.code).toBe("too_large");
  });
});

describe("api tokens", () => {
  it("authenticates like a session, shows the token once, and stops when revoked", async () => {
    const key = await newUser();
    const made = await call("POST", "/tokens", { key, body: { name: "poller" } });
    expect(made.status).toBe(201);
    const token = made.body.token as string;
    expect(token).toMatch(/^lw_/);
    expect((await call("GET", "/me", { key: token })).body.id).toBe(await userId(key));
    expect(await db.query(`SELECT 1 FROM loopway.api_tokens WHERE token_hash = $1`, [token])).toEqual([]);

    const list = await call("GET", "/tokens", { key });
    expect(list.body.data).toEqual([
      { id: made.body.id, name: "poller", created_at: expect.any(String), last_used_at: expect.any(String) },
    ]);
    expect((await call("DELETE", `/tokens/${made.body.id}`, { key })).status).toBe(204);
    expect((await call("GET", "/me", { key: token })).status).toBe(401);
  });

  it("refuses a made-up token, and another user's revoke", async () => {
    const key = await newUser("a");
    const made = await call("POST", "/tokens", { key, body: { name: "t" } });
    expect((await call("GET", "/me", { key: "lw_madeup" })).status).toBe(401);
    const stranger = await newUser("b");
    expect((await call("DELETE", `/tokens/${made.body.id}`, { key: stranger })).status).toBe(404);
    expect((await call("GET", "/me", { key: made.body.token })).status).toBe(200);
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

  it("refuses an unknown email when signups are closed", async () => {
    const a = createApi({
      getDb: async () => db,
      tokenSecret: SECRET,
      inboxSecretKey: TEST_INBOX_KEY,
      sendEmail: async (e) => void sent.push(e),
      signupsClosed: true,
    });
    const before = sent.length;
    const login = await post(a, "/auth/login", { email: "new@example.com" });
    expect(login.status).toBe(403);
    expect((await login.json()).error.code).toBe("signups_closed");
    expect(sent.length).toBe(before);
    const verify = await post(a, "/auth/verify", { email: "new@example.com", code: "ABCD2345", username: "newbie" });
    expect(verify.status).toBe(403);
    // An existing user still logs in.
    await createUser(db, { name: "Old", email: "closed-old@example.com" });
    expect((await post(a, "/auth/login", { email: "CLOSED-OLD@example.com" })).status).toBe(202);
    const res = await post(a, "/auth/verify", { email: "closed-old@example.com", code: lastCode() });
    expect(res.status).toBe(201);
  });

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
  });

  it("needs a free username to sign up, and keeps the code valid so they can retry", async () => {
    const a = loginApp();
    await newUser("Holder");
    const slug = (
      await db.query<{ username: string }>(
        `SELECT username FROM loopway.users WHERE username IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
    )[0]!.username;
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
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.text).toContain('<script type="module" src="/app.js">');
    expect(r.text).toContain('<link rel="icon" href="/favicon.ico"');
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
  });

  it("answers 404 on the old top-level API paths", async () => {
    const id = "00000000-0000-7000-8000-000000000000";
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
