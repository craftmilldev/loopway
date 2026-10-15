import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { PRESETS } from "@loopway/presets";
import { describe, expect, it } from "vitest";
import { clientBuild } from "../scripts/client.js";
import { createApi } from "../src/api.js";
import { SourceRegistry } from "@loopway/sources";
import { sources } from "../src/sources.js";
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
    expect(r.body.config).toEqual({ secret: inbox.config.secret, events: ["push"] });
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
    expect(Object.keys(p1.body.data[0]).sort()).toEqual(["event", "id", "inbox_id", "received_at", "seq"]);
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
  const settle = (inboxId: string) =>
    db.query(`UPDATE loopway.messages SET received_at = received_at - interval '1 minute' WHERE inbox_id = $1`, [
      inboxId,
    ]);
  const seqs = (r: { body: { data: { seq: number }[] } }) => r.body.data.map((e) => e.seq);

  it("versions a bot's prompt", async () => {
    const key = await newUser();
    const a = await newInbox(key);
    const bare = await call("POST", "/bots", {
      key,
      body: { name: "bare", model: "sonnet", harness: "claude", inbox_ids: [a.id] },
    });
    expect(bare.body.prompt_version).toBeNull();
    const created = await call("POST", "/bots", {
      key,
      body: { name: "dev", model: "sonnet", harness: "claude", inbox_ids: [a.id], prompt: "one" },
    });
    expect(created.body.prompt_version).toMatchObject({ version: 1, prompt: "one" });
    const id = created.body.id;
    const v2 = await call("POST", `/bots/${id}/versions`, { key, body: { prompt: "two" } });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, prompt: "two" });
    expect((await call("GET", `/bots/${id}`, { key })).body.prompt_version).toMatchObject({
      version: 2,
      prompt: "two",
    });
    expect(v2.body.rules).toBeNull();
    // Rules are versioned with the prompt, and a version without rules keeps the last ones.
    const rules = [{ types: ["com.github.*"], subject: "data.id", action: "'attach'" }];
    const v3 = await call("POST", `/bots/${id}/versions`, { key, body: { prompt: "three", rules } });
    expect(v3.body).toMatchObject({ version: 3, rules });
    const v4 = await call("POST", `/bots/${id}/versions`, { key, body: { prompt: "four" } });
    expect(v4.body).toMatchObject({ version: 4, rules });
    expect(
      (await call("POST", `/bots/${id}/versions`, { key, body: { prompt: "x", rules: [{ types: [] }] } })).status,
    ).toBe(400);
    expect((await call("POST", `/bots/${id}/versions`, { key, body: { prompt: "" } })).status).toBe(400);
    expect((await call("POST", `/bots/${id}/versions`, { key, body: { prompt: "x", rules: [] } })).status).toBe(400);
    // The blank preset is a valid create.
    const blank = await call("POST", "/bots", {
      key,
      body: { name: "blank", model: "sonnet", harness: "claude", inbox_ids: [a.id], prompt: PRESETS.blank!.prompt, rules: PRESETS.blank!.rules },
    });
    expect(blank.status).toBe(201);
    // Every rule needs an action.
    expect(
      (await call("POST", `/bots/${id}/versions`, { key, body: { prompt: "x", rules: [{ types: ["x"] }] } })).status,
    ).toBe(400);
    // Rules that don't parse are rejected on save, on versions and on create.
    const bad = [{ types: ["x"], subject: "data.(", action: "'attach'" }];
    const rejected = await call("POST", `/bots/${id}/versions`, { key, body: { prompt: "x", rules: bad } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("invalid_rules");
    const badCreate = await call("POST", "/bots", {
      key,
      body: { name: "bad", model: "sonnet", harness: "claude", inbox_ids: [a.id], prompt: "p", rules: bad },
    });
    expect(badCreate.body.error.code).toBe("invalid_rules");
    const other = await newUser();
    expect((await call("POST", `/bots/${id}/versions`, { key: other, body: { prompt: "x" } })).status).toBe(404);
    const rows = await db.query(`SELECT version FROM loopway.bot_versions WHERE bot_id = $1 ORDER BY version`, [id]);
    expect(rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);

    // They list newest first, for the owner only.
    const listed = await call("GET", `/bots/${id}/versions`, { key });
    expect(listed.body.data.map((v: any) => [v.version, v.prompt])).toEqual([
      [4, "four"],
      [3, "three"],
      [2, "two"],
      [1, "one"],
    ]);
    expect(listed.body.data[0].created_at).toMatch(/^\d{4}-/);
    expect((await call("GET", `/bots/${id}/versions`, { key: other })).status).toBe(404);
  });

  it("creates, lists, updates and deletes bots over the user's inboxes", async () => {
    const key = await newUser();
    const a = await newInbox(key);
    const b = await newInbox(key);
    const created = await call("POST", "/bots", {
      key,
      body: { name: "dev", model: "sonnet", harness: "claude", inbox_ids: [a.id] },
    });
    expect(created.status).toBe(201);
    const unknown = await call("POST", "/bots", {
      key,
      body: { name: "y", model: "sonet", inbox_ids: [a.id] },
    });
    expect(unknown.status).toBe(400);

    // Cursor takes any model name; the pair is checked again whenever either half changes.
    const cursor = await call("POST", "/bots", {
      key,
      body: { name: "cur", model: "auto", harness: "cursor", inbox_ids: [a.id] },
    });
    expect(cursor.body).toMatchObject({ harness: "cursor", model: "auto" });
    const back = await call("PATCH", `/bots/${cursor.body.id}`, { key, body: { harness: "claude" } });
    expect([back.status, back.body.error.code]).toEqual([400, "invalid_model"]);
    const both = await call("PATCH", `/bots/${cursor.body.id}`, { key, body: { harness: "claude", model: "opus" } });
    expect(both.body).toMatchObject({ harness: "claude", model: "opus" });
    const codex = await call("POST", "/bots", {
      key,
      body: { name: "z", model: "sonnet", harness: "codex", inbox_ids: [a.id] },
    });
    expect(codex.status).toBe(400);
    await call("DELETE", `/bots/${cursor.body.id}`, { key });

    expect(created.body).toMatchObject({
      name: "dev",
      harness: "claude",
      model: "sonnet",
      inbox_ids: [a.id],
      cursor: 0,
    });
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

    // Deleting is soft: the row stays, but the API no longer sees it.
    expect((await call("DELETE", `/bots/${id}`, { key })).status).toBe(204);
    expect((await call("GET", `/bots/${id}`, { key })).status).toBe(404);
    expect((await call("GET", "/bots", { key })).body.data).toEqual([]);
    expect((await call("GET", `/bots/${id}/messages`, { key })).status).toBe(404);
    expect((await call("DELETE", `/bots/${id}`, { key })).status).toBe(404);
    const [row] = await db.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM loopway.bots WHERE id = $1`, [
      id,
    ]);
    expect(row?.deleted_at).toBeTruthy();
  });

  it("won't attach another user's inbox, or show a bot to another user", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const theirs = await newInbox(b);
    const mine = await newInbox(a);
    const r = await call("POST", "/bots", {
      key: a,
      body: { name: "x", model: "sonnet", harness: "claude", inbox_ids: [theirs.id] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain(theirs.id);
    expect(
      (await call("POST", "/bots", { key: a, body: { name: "x", model: "sonnet", harness: "claude", inbox_ids: [] } }))
        .status,
    ).toBe(400);

    const bot = (
      await call("POST", "/bots", {
        key: a,
        body: { name: "x", model: "sonnet", harness: "claude", inbox_ids: [mine.id] },
      })
    ).body;
    expect((await call("PATCH", `/bots/${bot.id}`, { key: a, body: { inbox_ids: [theirs.id] } })).status).toBe(400);
    expect((await call("GET", `/bots/${bot.id}`, { key: b })).status).toBe(404);
    expect((await call("GET", `/bots/${bot.id}/messages`, { key: b })).status).toBe(404);
    expect((await call("GET", "/bots", { key: b })).body.data).toEqual([]);
    expect((await call("GET", "/bots/not-a-uuid", { key: a })).status).toBe(404);

    // The table refuses it too, not just the API.
    await expect(
      db.query(
        `INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, org_id) VALUES ($1, $2, (SELECT org_id FROM loopway.bots WHERE id = $1))`,
        [bot.id, theirs.id],
      ),
    ).rejects.toThrow();
  });

  it("reads only messages after creation, in seq order, holding back fresh ones", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    for (let i = 1; i <= 2; i++) await sendGithub(inbox, "pull_request", prPayload(i));
    // Not before[1]: ids made in the same millisecond can sort either way, so the newest is the highest seq.
    const newest = Math.max(...seqs(await call("GET", `/inboxes/${inbox.id}/messages`, { key })));

    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    expect(bot.cursor).toBe(newest);

    for (let i = 3; i <= 5; i++) await sendGithub(inbox, "pull_request", prPayload(i));
    // Just arrived: held back.
    expect((await call("GET", `/bots/${bot.id}/messages`, { key })).body.data).toEqual([]);

    await settle(inbox.id);
    const msgs = await call("GET", `/bots/${bot.id}/messages`, { key });
    expect(msgs.body.data.map((e: any) => e.event.data.number)).toEqual([3, 4, 5]);
    const after = seqs(msgs);
    expect(after).toEqual([...after].sort((x, y) => x - y));
    expect(after[0]).toBeGreaterThan(newest);
    expect(seqs(await call("GET", `/bots/${bot.id}/messages?limit=2`, { key }))).toEqual(after.slice(0, 2));

    // A fresh message stops the read there, even if an older-looking one follows it.
    await sendGithub(inbox, "pull_request", prPayload(6));
    await sendGithub(inbox, "pull_request", prPayload(7));
    await db.query(
      `UPDATE loopway.messages SET received_at = received_at - interval '1 minute'
       WHERE inbox_id = $1 AND seq = (SELECT max(seq) FROM loopway.messages WHERE inbox_id = $1)`,
      [inbox.id],
    );
    expect(seqs(await call("GET", `/bots/${bot.id}/messages`, { key }))).toEqual(after);
  });
});

describe("bot leases", () => {
  const settle = (inboxId: string) =>
    db.query(`UPDATE loopway.messages SET received_at = received_at - interval '1 minute' WHERE inbox_id = $1`, [
      inboxId,
    ]);

  it("lease / renew / release, and the cursor only moves forward under the live lease", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    const base = `/bots/${bot.id}`;

    const leased = await call("POST", `${base}/lease`, { key, body: { ttl_seconds: 60 } });
    expect(leased.status).toBe(200);
    const token = leased.body.lease.token;
    expect(token).toMatch(/^lk_/);
    expect(Date.parse(leased.body.lease.expires_at)).toBeGreaterThan(Date.now() + 50_000);
    // The lease token isn't part of the bot, but whether it's held is.
    const held = (await call("GET", base, { key })).body;
    expect(held).not.toHaveProperty("lock_token");
    expect(held).toMatchObject({ runner_id: null, leased_until: leased.body.lease.expires_at });

    // Another runner can't take it; the holder renews and keeps the token.
    const other = await call("POST", `${base}/lease`, { key });
    expect(other.status).toBe(409);
    expect(other.body.error.details).toEqual({ expires_at: leased.body.lease.expires_at });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("leased");
    expect((await call("POST", `${base}/lease`, { key, body: { lease_token: "lk_x" } })).body.error.code).toBe(
      "leased",
    );
    const renewed = await call("POST", `${base}/lease`, { key, body: { lease_token: token, ttl_seconds: 120 } });
    expect(renewed.body.lease.token).toBe(token);

    // The cursor moves only with the live token, and never backwards.
    for (let i = 1; i <= 3; i++) await sendGithub(inbox, "pull_request", prPayload(i));
    await settle(inbox.id);
    const msgs = (await call("GET", `${base}/messages`, { key })).body.data;
    expect(msgs).toHaveLength(3);
    const bad = await call("POST", `${base}/cursor`, { key, body: { seq: msgs[1].seq, lease_token: "lk_x" } });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("lease_mismatch");
    const moved = await call("POST", `${base}/cursor`, { key, body: { seq: msgs[1].seq, lease_token: token } });
    expect(moved.body.cursor).toBe(msgs[1].seq);
    expect((await call("GET", `${base}/messages`, { key })).body.data.map((e: any) => e.seq)).toEqual([msgs[2].seq]);
    const back = await call("POST", `${base}/cursor`, { key, body: { seq: msgs[0].seq, lease_token: token } });
    expect(back.body.cursor).toBe(msgs[1].seq);
    expect((await call("POST", `${base}/cursor`, { key, body: { seq: 1 } })).status).toBe(400);

    // Release frees it for the next runner; a wrong token can't.
    expect((await call("POST", `${base}/release`, { key, body: { lease_token: "lk_x" } })).body.error.code).toBe(
      "lease_mismatch",
    );
    expect((await call("POST", `${base}/release`, { key, body: { lease_token: token } })).status).toBe(204);
    expect((await call("POST", `${base}/release`, { key, body: { lease_token: token } })).body.error.code).toBe(
      "not_leased",
    );
    expect((await call("POST", `${base}/release`, { key, body: {} })).status).toBe(400);
    const next = await call("POST", `${base}/lease`, { key });
    expect(next.status).toBe(200);
    expect(next.body.lease.token).not.toBe(token);
    // The old token no longer moves the cursor.
    expect((await call("POST", `${base}/cursor`, { key, body: { seq: 9, lease_token: token } })).status).toBe(409);
  });

  it("the lease a dead runner left can be released by force", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    const base = `/bots/${bot.id}`;
    const dead = (await call("POST", `${base}/lease`, { key, body: { ttl_seconds: 3600 } })).body.lease.token;
    expect((await call("POST", `${base}/lease`, { key })).status).toBe(409);

    expect((await call("POST", `${base}/release`, { key, body: { force: true } })).status).toBe(204);
    // Forcing again, with nothing held, is fine too.
    expect((await call("POST", `${base}/release`, { key, body: { force: true } })).status).toBe(204);
    const next = await call("POST", `${base}/lease`, { key });
    expect(next.status).toBe(200);
    expect(next.body.lease.token).not.toBe(dead);
    expect((await call("POST", `${base}/cursor`, { key, body: { seq: 1, lease_token: dead } })).status).toBe(409);
  });

  it("expired leases can be taken over", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot = (
      await call("POST", "/bots", {
        key,
        body: { name: "b", model: "sonnet", harness: "claude", inbox_ids: [inbox.id] },
      })
    ).body;
    const first = (await call("POST", `/bots/${bot.id}/lease`, { key, body: { ttl_seconds: 1 } })).body.lease.token;
    await db.query(`UPDATE loopway.bots SET locked_until = now() - interval '1 second' WHERE id = $1`, [bot.id]);
    const second = await call("POST", `/bots/${bot.id}/lease`, { key });
    expect(second.status).toBe(200);
    expect(second.body.lease.token).not.toBe(first);
    expect((await call("POST", `/bots/${bot.id}/cursor`, { key, body: { seq: 1, lease_token: first } })).status).toBe(
      409,
    );
    // Another user never sees it.
    expect((await call("POST", `/bots/${bot.id}/lease`, { key: await newUser("b") })).status).toBe(404);
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
