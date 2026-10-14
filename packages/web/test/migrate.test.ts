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
});
