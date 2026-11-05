import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { openTestDb } from "../src/db/testing.js";
import { migrateBefore } from "./migrate-before.js";

// Migrations run on every deploy, against data that is already there. Each test rolls a database back to just before a
// migration, fills it as production would be then, applies the rest and checks what is left.
describe("migration 040_v2", () => {
  it("is the newest, so this test's rows are written for the schema before it", () => {
    expect(migrations.at(-1)!.version).toBe("040_v2");
  });

  it("moves usernames onto users, and drops orgs, inboxes, messages, bots, threads and runners", async () => {
    const db = await openTestDb();
    try {
      await migrateBefore(db, "040_v2");
      const id = {
        user: randomUUID(),
        nameless: randomUUID(),
        personal: randomUUID(),
        shared: randomUUID(),
        inbox: randomUUID(),
        bot: randomUUID(),
        thread: randomUUID(),
        runner: randomUUID(),
        message: randomUUID(),
      };
      const actor = `user:${id.user}`;
      await db.query(
        `INSERT INTO loopway.users (id, name, email) VALUES ($1, 'u', 'u@example.com'), ($2, 'n', 'n@example.com')`,
        [id.user, id.nameless],
      );
      await db.query(
        `INSERT INTO loopway.orgs (id, slug, name, personal_user_id)
         VALUES ($1, 'existing', 'existing', $2), ($3, 'team', 'team', NULL)`,
        [id.personal, id.user, id.shared],
      );
      await db.query(
        `INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, $3), ($4, $2, $3)`,
        [id.personal, id.user, actor, id.shared],
      );
      await db.query(
        `INSERT INTO loopway.inboxes (id, created_by, org_id, name, source_type, config)
         VALUES ($1, $2, $3, 'gh', 'github', '{}'::jsonb)`,
        [id.inbox, actor, id.personal],
      );
      await db.query(
        `INSERT INTO loopway.messages (id, inbox_id, ce_id, ce_source, ce_type, cloudevent)
         VALUES ($1, $2, 'ce-1', 'src', 'com.github.push', '{}'::jsonb)`,
        [id.message, id.inbox],
      );
      await db.query(
        `INSERT INTO loopway.bots (id, created_by, org_id, name, model, harness)
         VALUES ($1, $2, $3, 'b', 'sonnet', 'claude')`,
        [id.bot, actor, id.personal],
      );
      await db.query(`INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, org_id) VALUES ($1, $2, $3)`, [
        id.bot,
        id.inbox,
        id.personal,
      ]);

      expect(await migrate(db)).toEqual(["040_v2"]);

      expect(await db.query(`SELECT id, username FROM loopway.users ORDER BY email`)).toEqual([
        { id: id.nameless, username: null },
        { id: id.user, username: "existing" },
      ]);
      expect(await db.query(`SELECT 1 FROM loopway.inboxes`)).toEqual([]);
      expect(await db.query(`SELECT 1 FROM loopway.messages`)).toEqual([]);
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'loopway' ORDER BY 1`,
      );
      expect(tables.map((t) => t.table_name)).toEqual([
        "inboxes",
        "login_codes",
        "messages",
        "schema_migrations",
        "users",
      ]);
      // An inbox now belongs to its user, and goes with them.
      await db.query(
        `INSERT INTO loopway.inboxes (id, user_id, name, source_type, config) VALUES ($1, $2, 'gh', 'github', '{}'::jsonb)`,
        [randomUUID(), id.user],
      );
      await db.query(`DELETE FROM loopway.users WHERE id = $1`, [id.user]);
      expect(await db.query(`SELECT 1 FROM loopway.inboxes`)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
