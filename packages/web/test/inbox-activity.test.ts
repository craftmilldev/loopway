import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, db, newInbox, newUser } from "./helpers.js";

const DAY = 86_400_000;
/** Midnight UTC `offset` days ago, in ms. */
const dayStart = (offset: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - offset * DAY;
};
const date = (offset: number) => new Date(dayStart(offset)).toISOString().slice(0, 10);

async function setup() {
  const key = await newUser();
  return { key, inbox: await newInbox(key) };
}

/** A message the inbox received at `at` (ms). */
async function receive(inbox: { id: string }, at: number) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO loopway.messages (id, inbox_id, ce_id, ce_source, ce_type, cloudevent, received_at)
     VALUES ($1::uuid, $2, $1::text, 's', 't', '{}', $3)`,
    [id, inbox.id, new Date(at)],
  );
}

describe("inbox activity", () => {
  it("returns zeros and no last message for an inbox that received nothing", async () => {
    const { key, inbox } = await setup();
    const r = await call("GET", `/inboxes/${inbox.id}/activity`, { key });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ inbox_id: inbox.id, received: 0, messages: 0, last_message_at: null });
    expect(r.body.days).toHaveLength(14);
    expect(r.body.days.every((d: { received: number }) => d.received === 0)).toBe(true);
  });

  it("counts messages per day by received_at, with a day that has none", async () => {
    const { key, inbox } = await setup();
    await receive(inbox, dayStart(3) + 3_600_000);
    await receive(inbox, dayStart(2) + 1000);
    await receive(inbox, dayStart(2) + 2000);
    await receive(inbox, dayStart(0));
    const r = (await call("GET", `/inboxes/${inbox.id}/activity?days=5`, { key })).body;
    expect(r.days).toEqual([
      { date: date(4), received: 0 },
      { date: date(3), received: 1 },
      { date: date(2), received: 2 },
      { date: date(1), received: 0 },
      { date: date(0), received: 1 },
    ]);
    expect(r.received).toBe(4);
    expect(r.messages).toBe(4);
    expect(r.last_message_at).toBe(new Date(dayStart(0)).toISOString());
  });

  it("includes the first day of the window and leaves out the millisecond before it", async () => {
    const { key, inbox } = await setup();
    await receive(inbox, dayStart(2));
    await receive(inbox, dayStart(3) - 1);
    const r = (await call("GET", `/inboxes/${inbox.id}/activity?days=3`, { key })).body;
    expect(r.days[0]).toEqual({ date: date(2), received: 1 });
    expect(r.received).toBe(1);
    expect(r.messages).toBe(2);
  });

  it("reports the last message and total even when older than the window", async () => {
    const { key, inbox } = await setup();
    const at = dayStart(40) + 3_600_000;
    await receive(inbox, at);
    const r = (await call("GET", `/inboxes/${inbox.id}/activity`, { key })).body;
    expect(r).toMatchObject({ received: 0, messages: 1 });
    expect(r.last_message_at).toBe(new Date(at).toISOString());
  });

  it("lists every inbox of the user, and only theirs", async () => {
    const mine = await setup();
    const other = await setup();
    const second = await newInbox(mine.key);
    await receive(mine.inbox, dayStart(0));
    await receive(other.inbox, dayStart(0));
    const list = (await call("GET", "/inboxes/activity?days=7", { key: mine.key })).body.data;
    expect(list.map((a: { inbox_id: string }) => a.inbox_id).sort()).toEqual([mine.inbox.id, second.id].sort());
    expect(list.find((a: { inbox_id: string }) => a.inbox_id === mine.inbox.id).received).toBe(1);
    expect(list.find((a: { inbox_id: string }) => a.inbox_id === second.id).received).toBe(0);
    expect(list[0].days).toHaveLength(7);
  });

  it("hides another user's inbox", async () => {
    const mine = await setup();
    const other = await newUser("Other");
    await receive(mine.inbox, dayStart(0));
    expect((await call("GET", `/inboxes/${mine.inbox.id}/activity`, { key: other })).status).toBe(404);
    expect((await call("GET", "/inboxes/activity", { key: other })).body.data).toEqual([]);
  });

  it("needs a signed-in user", async () => {
    const { inbox } = await setup();
    expect((await call("GET", "/inboxes/activity")).status).toBe(401);
    expect((await call("GET", `/inboxes/${inbox.id}/activity`)).status).toBe(401);
  });

  it("rejects days outside 1..30 rather than clamping", async () => {
    const { key, inbox } = await setup();
    for (const days of ["0", "31", "-1", "x", "1.5"]) {
      expect((await call("GET", `/inboxes/activity?days=${days}`, { key })).status, days).toBe(400);
      expect((await call("GET", `/inboxes/${inbox.id}/activity?days=${days}`, { key })).status, days).toBe(400);
    }
    expect((await call("GET", "/inboxes/activity?days=30", { key })).body.data[0].days).toHaveLength(30);
  });
});
