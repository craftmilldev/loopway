import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { clientBuild } from "../scripts/client.js";
import { createApi } from "../src/api.js";
import { sources, SourceRegistry } from "../src/sources/index.js";
import { createUser } from "../src/store.js";
import { signSessionToken, verifyToken } from "../src/tokens.js";
import { app, call, db, newInbox, newUser, prPayload, SECRET, sendGithub } from "./helpers.js";

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
      // The loopway source has no common events: bots name their own types.
      expect(s.events.length > 0 || s.type === "loopway").toBe(true);
      expect(["loopway", "sender"]).toContain(s.secret.from);
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

describe("bots", () => {
  /** Ages an inbox's events past the holdback window, as if they'd arrived a minute ago. */
  const settle = (inboxId: string) =>
    db.query(`UPDATE loopway.events SET received_at = received_at - interval '1 minute' WHERE inbox_id = $1`, [
      inboxId,
    ]);
  const seqs = (r: { body: { data: { seq: number }[] } }) => r.body.data.map((e) => e.seq);

  it("creates, lists, updates and deletes bots over the user's inboxes", async () => {
    const key = await newUser();
    const a = await newInbox(key);
    const b = await newInbox(key);
    const created = await call("POST", "/bots", {
      key,
      body: { name: "dev", kind: "github-threads", inbox_ids: [a.id] },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "dev", kind: "github-threads", inbox_ids: [a.id], cursor: 0 });
    expect(created.body.leased_until).toBeNull();
    const id = created.body.id;

    expect((await call("GET", "/bots", { key })).body.data.map((x: any) => x.id)).toEqual([id]);
    const patched = await call("PATCH", `/bots/${id}`, { key, body: { name: "dev2", inbox_ids: [b.id, a.id, b.id] } });
    expect(patched.body.name).toBe("dev2");
    expect(patched.body.inbox_ids).toEqual([a.id, b.id].sort());
    expect((await call("PATCH", `/bots/${id}`, { key, body: { inbox_ids: [b.id] } })).body.inbox_ids).toEqual([b.id]);
    expect((await call("GET", `/bots/${id}`, { key })).body).toMatchObject({ name: "dev2", inbox_ids: [b.id] });

    // Deleting an inbox detaches it.
    await call("DELETE", `/inboxes/${b.id}`, { key });
    expect((await call("GET", `/bots/${id}`, { key })).body.inbox_ids).toEqual([]);

    expect((await call("DELETE", `/bots/${id}`, { key })).status).toBe(204);
    expect((await call("GET", `/bots/${id}`, { key })).status).toBe(404);
  });

  it("won't attach another user's inbox, or show a bot to another user", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const theirs = await newInbox(b);
    const mine = await newInbox(a);
    const r = await call("POST", "/bots", { key: a, body: { name: "x", kind: "k", inbox_ids: [theirs.id] } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain(theirs.id);
    expect((await call("POST", "/bots", { key: a, body: { name: "x", kind: "k", inbox_ids: [] } })).status).toBe(400);

    const bot = (await call("POST", "/bots", { key: a, body: { name: "x", kind: "k", inbox_ids: [mine.id] } })).body;
    expect((await call("PATCH", `/bots/${bot.id}`, { key: a, body: { inbox_ids: [theirs.id] } })).status).toBe(400);
    expect((await call("GET", `/bots/${bot.id}`, { key: b })).status).toBe(404);
    expect((await call("GET", `/bots/${bot.id}/messages`, { key: b })).status).toBe(404);
    expect((await call("GET", "/bots", { key: b })).body.data).toEqual([]);
    expect((await call("GET", "/bots/not-a-uuid", { key: a })).status).toBe(404);

    // The table refuses it too, not just the API.
    await expect(
      db.query(`INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, user_id) VALUES ($1, $2, $3)`, [
        bot.id,
        theirs.id,
        (await call("GET", "/me", { key: a })).body.id,
      ]),
    ).rejects.toThrow();
  });

  it("reads only messages after creation, in seq order, holding back fresh ones", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    for (let i = 1; i <= 2; i++) await sendGithub(inbox, "pull_request", prPayload(i));
    const before = (await call("GET", `/inboxes/${inbox.id}/events`, { key })).body.data;
    expect(before[1].seq).toBeGreaterThan(before[0].seq);

    const bot = (await call("POST", "/bots", { key, body: { name: "b", kind: "k", inbox_ids: [inbox.id] } })).body;
    expect(bot.cursor).toBe(before[1].seq);

    for (let i = 3; i <= 5; i++) await sendGithub(inbox, "pull_request", prPayload(i));
    // Just arrived: held back.
    expect((await call("GET", `/bots/${bot.id}/messages`, { key })).body.data).toEqual([]);

    await settle(inbox.id);
    const msgs = await call("GET", `/bots/${bot.id}/messages`, { key });
    expect(msgs.body.data.map((e: any) => e.event.data.number)).toEqual([3, 4, 5]);
    const after = seqs(msgs);
    expect(after).toEqual([...after].sort((x, y) => x - y));
    expect(after[0]).toBeGreaterThan(before[1].seq);
    expect(seqs(await call("GET", `/bots/${bot.id}/messages?limit=2`, { key }))).toEqual(after.slice(0, 2));

    // A fresh message stops the read there, even if an older-looking one follows it.
    await sendGithub(inbox, "pull_request", prPayload(6));
    await sendGithub(inbox, "pull_request", prPayload(7));
    await db.query(
      `UPDATE loopway.events SET received_at = received_at - interval '1 minute'
       WHERE inbox_id = $1 AND seq = (SELECT max(seq) FROM loopway.events WHERE inbox_id = $1)`,
      [inbox.id],
    );
    expect(seqs(await call("GET", `/bots/${bot.id}/messages`, { key }))).toEqual(after);
  });

  it("leases to one runner at a time; only the holder moves the cursor, and only forward", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot = (await call("POST", "/bots", { key, body: { name: "b", kind: "k", inbox_ids: [inbox.id] } })).body;
    for (let i = 1; i <= 3; i++) await sendGithub(inbox, "pull_request", prPayload(i));
    await settle(inbox.id);
    const [s1, s2, s3] = seqs(await call("GET", `/bots/${bot.id}/messages`, { key }));

    const first = await call("POST", `/bots/${bot.id}/lease`, { key, body: { ttl_seconds: 60 } });
    expect(first.status).toBe(200);
    const token = first.body.lease.token;
    expect(token).toMatch(/^lk_/);
    const second = await call("POST", `/bots/${bot.id}/lease`, { key });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("leased");
    expect((await call("GET", `/bots/${bot.id}`, { key })).body.leased_until).toBe(first.body.lease.expires_at);
    expect(JSON.stringify((await call("GET", `/bots/${bot.id}`, { key })).body)).not.toContain("lk_");

    const renewed = await call("POST", `/bots/${bot.id}/lease`, {
      key,
      body: { lease_token: token, ttl_seconds: 120 },
    });
    expect(renewed.body.lease.token).toBe(token);

    const cursor = (body: unknown) => call("POST", `/bots/${bot.id}/cursor`, { key, body });
    expect((await cursor({ seq: s2 })).status).toBe(400);
    expect((await cursor({ seq: s2, lease_token: "lk_nope" })).body.error.code).toBe("lease_mismatch");
    expect((await cursor({ seq: s2, lease_token: token })).body.cursor).toBe(s2);
    expect((await cursor({ seq: s1, lease_token: token })).body.cursor).toBe(s2);
    expect(seqs(await call("GET", `/bots/${bot.id}/messages`, { key }))).toEqual([s3]);

    // An expired lease can't move the cursor, and anyone can take it over.
    await db.query(`UPDATE loopway.bots SET locked_until = now() - interval '1 second' WHERE id = $1`, [bot.id]);
    expect((await cursor({ seq: s3, lease_token: token })).status).toBe(409);
    const taken = await call("POST", `/bots/${bot.id}/lease`, { key });
    expect(taken.status).toBe(200);
    expect(taken.body.lease.token).not.toBe(token);
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
    createApi({ getDb: async () => db, tokenSecret: SECRET, sendEmail: async (e) => void sent.push(e) });
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
    expect(await db.query(`SELECT 1 FROM loopway.users WHERE email = 'new.person@example.com'`)).toHaveLength(0);

    expect((await post(a, "/auth/verify", { email: "new.person@example.com", code: "ABCD2345" })).status).toBe(401);
    expect(await db.query(`SELECT 1 FROM loopway.users WHERE email = 'new.person@example.com'`)).toHaveLength(0);

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

  it("serves the page shell without auth", async () => {
    for (const path of ["/", "/login", "/dashboard", `/dashboard/${randomUUID()}`]) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.type).toContain("text/html");
      expect(r.text).toContain('<script type="module" src="/app.js">');
      expect(r.text).toContain('<link rel="icon" href="/favicon.ico"');
    }
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

  it("keeps /api as a bare health check and leaves the JSON routes alone", async () => {
    expect(await call("GET", "/api")).toEqual({ status: 200, body: { ok: true } });
    expect((await call("GET", "/inboxes")).status).toBe(401);
  });
});
