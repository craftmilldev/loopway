import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { openTestDb } from "../src/db/testing.js";

describe("migrate", () => {
  it("applies everything once when several builds migrate the same database at the same time", async () => {
    const db = await openTestDb();
    try {
      await db.query(`DROP SCHEMA loopway CASCADE`);
      const runs = await Promise.all([migrate(db), migrate(db), migrate(db)]);
      const all = migrations.map((m) => m.version);
      expect(runs.filter((r) => r.length > 0)).toEqual([all]);
      expect(await migrate(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("refuses to run when an applied migration's SQL has changed since it was applied", async () => {
    const db = await openTestDb();
    const { version } = migrations[0]!;
    try {
      await db.query(`UPDATE loopway.schema_migrations SET checksum = 'edited' WHERE version = $1`, [version]);
      await expect(migrate(db)).rejects.toThrow(new RegExp(`${version} was edited`));
    } finally {
      await db.close();
    }
  });

  it("drops every row and re-applies all migrations when reset is set, even if one was edited", async () => {
    const db = await openTestDb();
    try {
      await db.query(`INSERT INTO loopway.users (id, name, email) VALUES (gen_random_uuid(), 'u', 'u@example.com')`);
      await db.query(`UPDATE loopway.schema_migrations SET checksum = 'edited'`);
      expect(await migrate(db, { reset: true })).toEqual(migrations.map((m) => m.version));
      expect(await db.query(`SELECT 1 FROM loopway.users`)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("records checksums for migrations applied before checksums existed", async () => {
    const db = await openTestDb();
    try {
      await db.query(`UPDATE loopway.schema_migrations SET checksum = NULL`);
      expect(await migrate(db)).toEqual([]);
      const rows = await db.query<{ checksum: string | null }>(`SELECT checksum FROM loopway.schema_migrations`);
      expect(rows.every((r) => r.checksum)).toBe(true);
    } finally {
      await db.close();
    }
  });
});
