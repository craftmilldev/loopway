import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db } from "../src/db/index.js";
import { openTestDb, seedFixtures } from "../src/db/testing.js";
import { getInbox, listMessages } from "../src/store.js";

let db: Db;
let fx: Awaited<ReturnType<typeof seedFixtures>>;
beforeAll(async () => {
  db = await openTestDb();
  fx = await seedFixtures(db);
});
afterAll(() => db.close());

describe("seedFixtures", () => {
  it("builds a connected world on the migrated schema", async () => {
    expect(await getInbox(db, fx.inboxId, fx.userId)).toMatchObject({ id: fx.inboxId, user_id: fx.userId });
    const { messages } = await listMessages(db, fx.inboxId, { limit: 10, order: "asc" });
    expect(messages.map((m) => m.id)).toEqual([fx.messageId]);
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
