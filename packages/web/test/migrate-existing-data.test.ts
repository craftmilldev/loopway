import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { openTestDb } from "../src/db/testing.js";
import { migrateBefore } from "./migrate-before.js";

// Migrations run on every deploy, against data that is already there. Each test rolls a database back to just before a
// migration, fills it as production would be then, applies the rest and checks what is left.
describe("migration 040_v1", () => {
  it("is the newest, so this test's rows are written for the schema before it", () => {
    expect(migrations.at(-1)!.version).toBe("040_v1");
  });

  it("moves usernames onto users and adds the new tables, leaving the old deployment's alone", async () => {
    const db = await openTestDb();
    try {
      await migrateBefore(db, "040_v1");
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

      expect(await migrate(db)).toEqual(["040_v1"]);

      expect(await db.query(`SELECT id, username FROM loopway.users ORDER BY email`)).toEqual([
        { id: id.nameless, username: null },
        { id: id.user, username: "existing" },
      ]);
      // The old tables stay, with their rows: the deployment this replaces is still serving when this runs.
      const old = ["orgs", "org_members", "inboxes", "messages", "bots", "bot_inboxes"];
      for (const table of old) {
        expect((await db.query(`SELECT 1 FROM loopway.${table}`)).length, table).toBeGreaterThan(0);
      }
      const inboxes = await db.query(`SELECT id FROM loopway.inboxes WHERE org_id = $1`, [id.personal]);
      expect(inboxes).toEqual([{ id: id.inbox }]);
      expect(await db.query(`SELECT 1 FROM loopway.inbox_messages`)).toEqual([]);
      // A source belongs to its user.
      await db.query(`INSERT INTO loopway.sources (id, user_id, name, source_type) VALUES ($1, $2, 'gh', 'github')`, [
        randomUUID(),
        id.user,
      ]);
      expect(await db.query(`SELECT 1 FROM loopway.sources`)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
