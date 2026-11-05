import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db } from "../src/db/index.js";
import { openTestDb, seedFixtures } from "../src/db/testing.js";
import { getMessage, getSource } from "../src/store.js";

let db: Db;
let fx: Awaited<ReturnType<typeof seedFixtures>>;
beforeAll(async () => {
  db = await openTestDb();
  fx = await seedFixtures(db);
});
afterAll(() => db.close());

describe("seedFixtures", () => {
  it("builds a connected world on the migrated schema", async () => {
    expect(await getSource(db, fx.sourceId, fx.userId)).toMatchObject({ id: fx.sourceId, user_id: fx.userId });
    expect(await getMessage(db, fx.userId, fx.messageId)).toMatchObject({ source_id: fx.sourceId });
  });

  it("seeds each database on its own", async () => {
    const other = await openTestDb();
    try {
      expect(await other.query(`SELECT 1 FROM loopway.users`)).toHaveLength(0);
      const again = await seedFixtures(other);
      expect(again.userId).not.toBe(fx.userId);
    } finally {
      await other.close();
    }
  });
});
