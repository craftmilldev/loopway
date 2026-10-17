import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { openTestDb } from "../src/db/testing.js";
import { migrateBefore } from "./migrate-before.js";

// Migrations run on every deploy, against data that is already there. This rolls a database back to just before the
// newest migration, fills it as production would be then, applies the newest migration and checks the rows survived.
// The rows below are written for the schema before the newest migration: when a new migration lands, this test
// then rolls back to before *that* one, so update the INSERTs to its previous schema if they no longer fit.
describe("the newest migration over existing data", () => {
  it("keeps every row", async () => {
    const newest = migrations.at(-1)!.version;
    const db = await openTestDb();
    try {
      await migrateBefore(db, newest);
      const id = {
        user: randomUUID(),
        org: randomUUID(),
        inbox: randomUUID(),
        bot: randomUUID(),
        thread: randomUUID(),
        runner: randomUUID(),
        message: randomUUID(),
      };
      const actor = `user:${id.user}`;
      await db.query(`INSERT INTO loopway.users (id, name, email) VALUES ($1, 'u', 'u@example.com')`, [id.user]);
      await db.query(
        `INSERT INTO loopway.orgs (id, slug, name, personal_user_id) VALUES ($1, 'existing', 'existing', $2)`,
        [id.org, id.user],
      );
      await db.query(`INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, $3)`, [
        id.org,
        id.user,
        actor,
      ]);
      await db.query(
        `INSERT INTO loopway.inboxes (id, created_by, org_id, name, source_type) VALUES ($1, $2, $3, 'i', 'github')`,
        [id.inbox, actor, id.org],
      );
      await db.query(
        `INSERT INTO loopway.bots (id, created_by, org_id, name, model, harness) VALUES ($1, $2, $3, 'b', 'sonnet', 'claude')`,
        [id.bot, actor, id.org],
      );
      await db.query(`INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, org_id) VALUES ($1, $2, $3)`, [
        id.bot,
        id.inbox,
        id.org,
      ]);
      await db.query(`INSERT INTO loopway.runners (id, created_by, org_id, name) VALUES ($1, $2, $3, 'r')`, [
        id.runner,
        actor,
        id.org,
      ]);
      await db.query(`INSERT INTO loopway.threads (id, bot_id, created_by, org_id) VALUES ($1, $2, $3, $4)`, [
        id.thread,
        id.bot,
        `bot:${id.bot}`,
        id.org,
      ]);
      await db.query(
        `INSERT INTO loopway.messages (id, inbox_id, ce_id, ce_source, ce_type, cloudevent) VALUES ($1, $2, 'ce-1', 'src', 'com.example.t', $3::jsonb)`,
        [id.message, id.inbox, { specversion: "1.0", id: "ce-1", source: "src", type: "com.example.t" }],
      );

      await migrate(db);

      const count = async (table: string) =>
        Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM loopway.${table}`))[0]!.n);
      for (const table of [
        "users",
        "orgs",
        "org_members",
        "inboxes",
        "bots",
        "bot_inboxes",
        "runners",
        "threads",
        "messages",
      ])
        expect(await count(table), table).toBe(1);
      expect(
        await db.query(`SELECT id FROM loopway.threads WHERE id = $1 AND bot_id = $2`, [id.thread, id.bot]),
      ).toHaveLength(1);
      expect(await db.query(`SELECT 1 FROM loopway.schema_migrations WHERE version = $1`, [newest])).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
