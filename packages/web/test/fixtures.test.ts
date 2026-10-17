import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db } from "../src/db/index.js";
import { openTestDb, seedFixtures } from "../src/db/testing.js";
import { listThreads, getBot, listRunners } from "../src/store.js";

let db: Db;
let fx: Awaited<ReturnType<typeof seedFixtures>>;
beforeAll(async () => {
  db = await openTestDb();
  fx = await seedFixtures(db);
});
afterAll(() => db.close());

describe("seedFixtures", () => {
  it("builds a connected world on the migrated schema", async () => {
    const bot = await getBot(db, fx.botId, fx.userId);
    expect(bot).toMatchObject({ org_id: fx.orgId, inbox_ids: [fx.inboxId] });
    const threads = await listThreads(db, fx.botId, "all");
    expect(threads.map((t) => t.id)).toEqual([fx.threadId]);
    expect((await listRunners(db, fx.userId)).map((r) => r.id)).toEqual([fx.runnerId]);
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
