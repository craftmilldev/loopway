import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";

let db: Db;
beforeAll(async () => {
  db = await openDb({ pgliteDir: "memory://" });
  await db.query(`CREATE TABLE tx_t (n int)`);
});
afterAll(() => db.close());

describe("Db.transaction", () => {
  it("commits when fn resolves", async () => {
    const r = await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO tx_t VALUES ($1)`, [1]);
      return (await tx.query<{ n: number }>(`SELECT n FROM tx_t`)).length;
    });
    expect(r).toBe(1);
    expect(await db.query(`SELECT n FROM tx_t`)).toHaveLength(1);
  });

  it("rolls back when fn throws", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`INSERT INTO tx_t VALUES (2)`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query(`SELECT n FROM tx_t`)).toHaveLength(1);
  });
});
