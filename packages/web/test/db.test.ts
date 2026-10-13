import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";

let db: Db;
beforeAll(async () => {
  db = await openTestDb();
  await db.query(`CREATE TABLE loopway.t (id serial PRIMARY KEY, data jsonb, tags jsonb)`);
});
afterAll(() => db.close());

describe("db", () => {
  it("stores jsonb objects and arrays once-encoded", async () => {
    await db.query(`INSERT INTO loopway.t (data, tags) VALUES ($1, $2)`, [{ a: 1 }, ["x", "y"]]);
    const [row] = await db.query<{ type: string; tags_type: string }>(
      `SELECT jsonb_typeof(data) AS type, jsonb_typeof(tags) AS tags_type FROM loopway.t`,
    );
    expect(row).toEqual({ type: "object", tags_type: "array" });
  });

  it("commits a transaction", async () => {
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO loopway.t (data) VALUES ($1)`, [{ commit: true }]);
    });
    expect(await db.query(`SELECT 1 FROM loopway.t WHERE data->>'commit' = 'true'`)).toHaveLength(1);
  });

  it("rolls back a transaction that throws", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`INSERT INTO loopway.t (data) VALUES ($1)`, [{ rollback: true }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query(`SELECT 1 FROM loopway.t WHERE data->>'rollback' = 'true'`)).toHaveLength(0);
  });
});
