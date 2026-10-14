import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { migrateBefore } from "./migrate-before.js";
import { call, db, newInbox, newUser, newUserWithoutOrg, prPayload, sendGithub } from "./helpers.js";

const rows = <T>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);

describe("dual-write of org_id", () => {
  it("puts inboxes, bots, bot_inboxes, threads and runners in the creator's personal org", async () => {
    const key = await newUser("Owner");
    expect((await call("PATCH", "/me/username", { key, body: { username: "org-owner" } })).status).toBe(200);
    const [org] = await rows<{ id: string }>(`SELECT id FROM loopway.orgs WHERE slug = 'org-owner'`);

    const inbox = await newInbox(key);
    await sendGithub(inbox, "pull_request", prPayload(1));
    const message = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data[0] as { id: string };
    const bot = (await call("POST", "/bots", { key, body: { name: "b", model: "sonnet", inbox_ids: [inbox.id] } }))
      .body;
    const lease = (await call("POST", `/bots/${bot.id}/lease`, { key, body: {} })).body.lease.token;
    const runnerId = randomUUID();
    const runner = (await call("POST", "/runners", { key, body: { id: runnerId, name: "laptop" } })).body;
    const thread = randomUUID();
    const assigned = await call("POST", `/bots/${bot.id}/assign`, {
      key,
      body: { lease_token: lease, cursor: 0, assignments: [{ message_id: message.id, thread_id: thread }] },
    });
    expect(assigned.status).toBe(200);

    // the serialized responses carry it
    expect([inbox, bot, runner].map((x) => (x as { org_id: string }).org_id)).toEqual([org!.id, org!.id, org!.id]);
    expect((await call("GET", `/inboxes/${inbox.id}`, { key })).body.org_id).toBe(org!.id);
    expect((await call("GET", "/runners", { key })).body.data[0].org_id).toBe(org!.id);

    for (const [table, id, col] of [
      ["inboxes", inbox.id, "id"],
      ["bots", bot.id, "id"],
      ["bot_inboxes", bot.id, "bot_id"],
      ["threads", thread, "id"],
      ["runners", runnerId, "id"],
    ]) {
      const found = await rows<{ org_id: string }>(`SELECT org_id FROM loopway.${table} WHERE ${col} = $1`, [id]);
      expect(
        found.map((r) => r.org_id),
        table,
      ).toEqual([org!.id]);
    }
  });
});

describe("org constraints", () => {
  async function otherOrg() {
    const id = randomUUID();
    await rows(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, $2, $2)`, [id, `other-${id.slice(0, 8)}`]);
    return id;
  }

  const fkViolation = { code: "23503" };

  it("rejects linking a bot and an inbox from different orgs", async () => {
    const key = await newUser();
    const mine = await newInbox(key);
    const moved = await newInbox(key);
    const bot = (await call("POST", "/bots", { key, body: { name: "b", model: "sonnet", inbox_ids: [mine.id] } })).body;
    await rows(`UPDATE loopway.inboxes SET org_id = $2 WHERE id = $1`, [moved.id, await otherOrg()]);
    await expect(
      rows(
        `INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, org_id) SELECT id, $2, org_id FROM loopway.bots WHERE id = $1`,
        [bot.id, moved.id],
      ),
    ).rejects.toMatchObject(fkViolation);
  });

  it("rejects a thread whose org differs from its bot's", async () => {
    const key = await newUser();
    const inbox = await newInbox(key);
    const bot = (await call("POST", "/bots", { key, body: { name: "b", model: "sonnet", inbox_ids: [inbox.id] } }))
      .body;
    await expect(
      rows(
        `INSERT INTO loopway.threads (id, bot_id, created_by, org_id) SELECT $2, id, created_by, $3 FROM loopway.bots WHERE id = $1`,
        [bot.id, randomUUID(), await otherOrg()],
      ),
    ).rejects.toMatchObject(fkViolation);
  });
});

describe("backfill (018_org_ownership)", () => {
  /** Rolls a migrated database back to before 018, fills it with owners as the real one had, and migrates again. */
  async function backfill() {
    const fresh = await openTestDb();
    try {
      await migrateBefore(fresh, "018_org_ownership");

      const users = {
        matthew: randomUUID(),
        named: randomUUID(),
      };
      const emails = { matthew: "Matthew@craftmill.dev", named: "named@example.com" };
      const ids: Record<string, { inbox: string; bot: string; thread: string; runner: string }> = {};
      for (const [who, userId] of Object.entries(users)) {
        await fresh.query(`INSERT INTO loopway.users (id, name, email) VALUES ($1, $2, $3)`, [
          userId,
          who,
          emails[who as keyof typeof emails],
        ]);
        const x = (ids[who] = { inbox: randomUUID(), bot: randomUUID(), thread: randomUUID(), runner: randomUUID() });
        await fresh.query(
          `INSERT INTO loopway.inboxes (id, user_id, name, source_type) VALUES ($1, $2, 'i', 'github')`,
          [x.inbox, userId],
        );
        await fresh.query(`INSERT INTO loopway.bots (id, user_id, name, model) VALUES ($1, $2, 'b', 'sonnet')`, [
          x.bot,
          userId,
        ]);
        await fresh.query(`INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, user_id) VALUES ($1, $2, $3)`, [
          x.bot,
          x.inbox,
          userId,
        ]);
        await fresh.query(`INSERT INTO loopway.threads (id, bot_id, user_id) VALUES ($1, $2, $3)`, [
          x.thread,
          x.bot,
          userId,
        ]);
        await fresh.query(`INSERT INTO loopway.runners (id, user_id, name) VALUES ($1, $2, 'r')`, [x.runner, userId]);
      }
      // 017's orgs, as it made them for matthew, plus a personal org for the user who had picked a username
      const org = { mc: randomUUID(), craftmill: randomUUID(), named: randomUUID() };
      await fresh.query(
        `INSERT INTO loopway.orgs (id, slug, name, personal_user_id) VALUES ($1, 'mcwhittemore', 'mcwhittemore', $2)`,
        [org.mc, users.matthew],
      );
      await fresh.query(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, 'craftmill', 'craftmill')`, [
        org.craftmill,
      ]);
      await fresh.query(
        `INSERT INTO loopway.orgs (id, slug, name, personal_user_id) VALUES ($1, 'named', 'named', $2)`,
        [org.named, users.named],
      );

      expect((await migrate(fresh))[0]).toEqual("018_org_ownership");

      const result: Record<string, Record<string, string[]>> = {};
      for (const [who, x] of Object.entries(ids)) {
        result[who] = {};
        for (const [table, col, id] of [
          ["inboxes", "id", x.inbox],
          ["bots", "id", x.bot],
          ["bot_inboxes", "bot_id", x.bot],
          ["threads", "id", x.thread],
          ["runners", "id", x.runner],
        ] as const) {
          const found = await fresh.query<{ org_id: string }>(`SELECT org_id FROM loopway.${table} WHERE ${col} = $1`, [
            id,
          ]);
          result[who][table] = found.map((r) => r.org_id);
        }
      }
      return { result, org };
    } finally {
      await fresh.close();
    }
  }

  it("moves everything matthew@craftmill.dev owned to craftmill and everyone else's to their personal org", async () => {
    const { result, org } = await backfill();
    const all = (o: string) => ({ inboxes: [o], bots: [o], bot_inboxes: [o], threads: [o], runners: [o] });
    expect(result.matthew).toEqual(all(org.craftmill));
    expect(result.named).toEqual(all(org.named));
  });

  it("is a no-op on a database with no rows", async () => {
    const fresh = await openTestDb();
    try {
      const nulls = await fresh.query(`SELECT 1 FROM loopway.inboxes WHERE org_id IS NULL`);
      expect(nulls).toEqual([]);
    } finally {
      await fresh.close();
    }
  });
});

describe("inboxes across orgs", () => {
  it("answers 400 inbox_org_mismatch instead of failing the foreign key", async () => {
    const key = await newUser();
    const a = await newInbox(key);
    const b = await newInbox(key);
    const other = randomUUID();
    const otherSlug = `other-${other.slice(0, 8)}`;
    await rows(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, $2, $2)`, [other, otherSlug]);
    await rows(
      `INSERT INTO loopway.org_members (org_id, user_id) VALUES ($1, (SELECT substring(created_by FROM 6)::uuid FROM loopway.inboxes WHERE id = $2))`,
      [other, b.id],
    );
    await rows(`UPDATE loopway.inboxes SET org_id = $2 WHERE id = $1`, [b.id, other]);

    const create = await call("POST", "/bots", {
      key,
      body: { org: otherSlug, name: "b", model: "sonnet", inbox_ids: [a.id, b.id] },
    });
    expect([create.status, create.body.error.code]).toEqual([400, "inbox_org_mismatch"]);

    // a bot in the other org takes b but not a
    const bot = (
      await call("POST", "/bots", { key, body: { org: otherSlug, name: "b", model: "sonnet", inbox_ids: [b.id] } })
    ).body;
    expect(bot.org_id).toBe(other);
    const patch = await call("PATCH", `/bots/${bot.id}`, { key, body: { inbox_ids: [b.id, a.id] } });
    expect([patch.status, patch.body.error.code]).toEqual([400, "inbox_org_mismatch"]);
    expect((await call("PATCH", `/bots/${bot.id}`, { key, body: { inbox_ids: [b.id] } })).status).toBe(200);
  });
});

describe("before a username is chosen", () => {
  it("has no org to create an inbox in and answers 404 for runners, and works after", async () => {
    const key = await newUserWithoutOrg();
    const inbox = await call("POST", "/inboxes", {
      key,
      body: { org: "now-named", name: "gh", source_type: "github" },
    });
    expect([inbox.status, inbox.body.error.code]).toEqual([404, "not_found"]);
    const runner = await call("POST", "/runners", {
      key,
      body: { org: "now-named", id: randomUUID(), name: "laptop" },
    });
    expect([runner.status, runner.body.error.code]).toEqual([404, "not_found"]);

    expect((await call("PATCH", "/me/username", { key, body: { username: "now-named" } })).status).toBe(200);
    expect((await call("POST", "/inboxes", { key, body: { name: "gh", source_type: "github" } })).status).toBe(201);
  });
});
