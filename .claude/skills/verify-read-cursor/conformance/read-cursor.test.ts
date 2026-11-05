import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CloudEvent } from "@web/cloudevents.js";
import type { Db } from "@web/db/index.js";
import { openTestDb } from "@web/db/testing.js";
import { createUser, insertMessage, READ_HOLDBACK_SECONDS, readMessages } from "@web/store.js";

/**
 * Ties spec/cursor.tla to the real store on real Postgres: the facts the model takes from the code, the `slow-insert`
 * limit replayed for real, and paging through ties. See ../SKILL.md. The tests that wait out the hold-back run one at
 * a time, because a stuck insert holds one of the pool's five connections.
 */

let db: Db;
let serial = 0;
const HOLDBACK_MS = READ_HOLDBACK_SECONDS * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const event = (): CloudEvent => ({
  specversion: "1.0",
  id: `conformance-${++serial}`,
  source: "https://example.com/conformance",
  type: "com.example.conformance",
  time: new Date().toISOString(),
  data: {},
});

const newUser = async () => (await createUser(db, { name: `conformance-${++serial}` })).user.id;

const insert = async (user: string, on: Db = db, ce = event()) => (await insertMessage(on, user, null, ce)).id;

/**
 * Makes a real insert of `ce` wait. The blocker holds the row's unique key in an open transaction, so `insertMessage`
 * stamps its row and then waits on the lock, as it would behind any stuck writer. Rolling back lets it commit.
 */
async function blockInsertsOf(user: string, ce: CloudEvent) {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let locked = () => {};
  const ready = new Promise<void>((r) => (locked = r));
  const blocker = db
    .transaction(async (tx) => {
      await tx.query(
        `INSERT INTO loopway.inbox_messages (id, user_id, ce_id, ce_source, ce_type, cloudevent)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb)`,
        [user, ce.id, ce.source, ce.type, ce],
      );
      locked();
      await held;
      throw new Error("roll back");
    })
    .catch(() => {});
  await ready;
  return async () => {
    release();
    await blocker;
  };
}

/** A database whose client stalls after the real INSERT has finished, before its COMMIT is sent. */
const stallingBeforeCommit = (ms: number): Db => ({
  ...db,
  transaction: (fn) =>
    db.transaction(async (tx) => {
      const result = await fn(tx);
      await sleep(ms);
      return result;
    }),
});

/** Moves every message of this user behind the hold-back, so a test needn't wait it out. */
const age = (user: string) =>
  db.query(`UPDATE loopway.inbox_messages SET received_at = received_at - interval '1 minute' WHERE user_id = $1`, [
    user,
  ]);

interface Cursor {
  since: string;
  after?: string;
}

/** What `drain` in packages/cli/src/commands/read.ts does with a page: one cursor move per message, then next_since. */
async function drain(user: string, limit: number, start: Cursor) {
  const seen: string[] = [];
  let cursor = start;
  // A cursor that stops moving would page forever: that's a failure, not a hang.
  for (let pages = 0; pages < 200; pages++) {
    const page = await readMessages(db, user, { ...cursor, limit });
    seen.push(...page.messages.map((m) => m.id));
    cursor = { since: page.nextSince, after: page.nextAfter ?? undefined };
    if (!page.hasMore) return { seen, cursor };
  }
  throw new Error(`still paging after 200 pages: the cursor isn't moving (at ${JSON.stringify(cursor)})`);
}

const fromTheStart: Cursor = { since: "0" };

beforeAll(async () => {
  db = await openTestDb();
});
afterAll(() => db.close());

describe("what the model takes from the code", () => {
  it("an insert's row can't be read until it commits", async () => {
    const user = await newUser();
    const insertion = insert(user, stallingBeforeCommit(300));
    await sleep(100);
    await age(user); // sees nothing to age: the row isn't committed
    expect((await drain(user, 50, fromTheStart)).seen).toEqual([]);
    const id = await insertion;
    await age(user);
    expect((await drain(user, 50, fromTheStart)).seen).toEqual([id]);
  });

  it("a row is stamped inside its insert, before it commits", async () => {
    const user = await newUser();
    const insertion = insert(user, stallingBeforeCommit(300));
    await sleep(100);
    const later = await insert(user);
    const early = await insertion;
    await age(user);
    expect((await drain(user, 50, fromTheStart)).seen).toEqual([early, later]);
  });

  it("a read holds back messages newer than the hold-back", async () => {
    const user = await newUser();
    await insert(user);
    expect((await drain(user, 50, fromTheStart)).seen).toEqual([]);
  });

  it("reading to the end moves the cursor to head, and a row at head comes next", async () => {
    const user = await newUser();
    const id = await insert(user);
    const { cursor } = await drain(user, 50, fromTheStart);
    expect(cursor.after).toBeUndefined();
    await db.query(
      `UPDATE loopway.inbox_messages SET received_at = 'epoch'::timestamptz + $1::bigint * interval '1 microsecond' WHERE id = $2`,
      [cursor.since, id],
    );
    await sleep(5);
    expect((await drain(user, 50, cursor)).seen).toEqual([id]);
  });
});

describe("a slow insert against the hold-back", () => {
  it("an insert held up by a lock, shorter than the hold-back, isn't lost", async () => {
    const user = await newUser();
    const ce = event();
    const unblock = await blockInsertsOf(user, ce);
    const slowInsert = insert(user, db, ce);
    await sleep(100);
    const quick = await insert(user);
    const { cursor } = await drain(user, 50, fromTheStart); // reading while the slow insert waits
    await sleep(100);
    await unblock();
    const slow = await slowInsert;
    await sleep(HOLDBACK_MS + 200);
    expect((await drain(user, 50, cursor)).seen).toEqual([slow, quick]);
  });

  it("a lock that outlasts the insert timeout fails the insert, so it can't commit late", async () => {
    const user = await newUser();
    const ce = event();
    const unblock = await blockInsertsOf(user, ce);
    await expect(insert(user, db, ce)).rejects.toThrow(/lock timeout|statement timeout/);
    await unblock();
    await age(user);
    expect((await drain(user, 50, fromTheStart)).seen).toEqual([]);
  });

  // The `slow-insert` case, for real. When this fails, the limit is gone: see "When the code changes" in SKILL.md.
  it("LIMIT: a commit that stalls past the hold-back is lost to a reader that passed it", async () => {
    const user = await newUser();
    const slowInsert = insert(user, stallingBeforeCommit(HOLDBACK_MS + 1500));
    await sleep(100);
    const quick = await insert(user);
    await sleep(HOLDBACK_MS + 200);
    const read = await drain(user, 50, fromTheStart);
    expect(read.seen).toEqual([quick]);

    const slow = await slowInsert;
    await sleep(HOLDBACK_MS + 200);
    expect((await drain(user, 50, fromTheStart)).seen).toEqual([slow, quick]); // it's stored
    expect((await drain(user, 50, read.cursor)).seen).toEqual([]); // and this reader never gets it
  });
});

describe("paging", () => {
  it.each([1, 2, 3, 5, 7, 8, 100])("a page of %i returns seven tied messages, each once", async (limit) => {
    const user = await newUser();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await insert(user));
    // clock_timestamp() rarely ties on its own, so this makes the tie the code has to survive.
    await db.query(`UPDATE loopway.inbox_messages SET received_at = now() - interval '1 minute' WHERE user_id = $1`, [
      user,
    ]);
    expect((await drain(user, limit, fromTheStart)).seen).toEqual([...ids].sort());
  });

  it.each([1, 2, 3, 7, 100])("a page of %i returns messages across timestamps in order, each once", async (limit) => {
    const user = await newUser();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await insert(user));
    await age(user);
    expect((await drain(user, limit, fromTheStart)).seen).toEqual(ids);
  });
});
