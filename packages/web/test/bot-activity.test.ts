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
  const inbox = await newInbox(key);
  const bot = (await call("POST", "/bots", { key, body: { name: "b", model: "sonnet", inbox_ids: [inbox.id] } })).body;
  return { key, inbox, bot, threads: new Map<string, string>() };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function thread(ctx: Ctx, name: string) {
  let id = ctx.threads.get(name);
  if (!id) {
    id = randomUUID();
    ctx.threads.set(name, id);
    await db.query(
      `INSERT INTO loopway.threads (id, bot_id, user_id, org_id) SELECT $1, id, user_id, org_id FROM loopway.bots WHERE id = $2`,
      [id, ctx.bot.id],
    );
  }
  return id;
}

/** A message in thread `name`, delivered at `at` (ms) after waiting `waitSeconds`; never delivered when `at` is null. */
async function deliver(ctx: Ctx, name: string, at: number | null, waitSeconds = 10) {
  const messageId = randomUUID();
  await db.query(
    `INSERT INTO loopway.messages (id, inbox_id, ce_id, ce_source, ce_type, cloudevent) VALUES ($1::uuid, $2, $1::text, 's', 't', '{}')`,
    [messageId, ctx.inbox.id],
  );
  await db.query(
    `INSERT INTO loopway.thread_messages (thread_id, bot_id, message_id, state, assigned_at, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      await thread(ctx, name),
      ctx.bot.id,
      messageId,
      at === null ? "waiting" : "delivered",
      new Date((at ?? Date.now()) - waitSeconds * 1000),
      at === null ? null : new Date(at),
    ],
  );
}

describe("bot activity", () => {
  it("returns zeros and no last delivery for a bot that never delivered", async () => {
    const ctx = await setup();
    await deliver(ctx, "t", null);
    const r = await call("GET", `/bots/${ctx.bot.id}/activity`, { key: ctx.key });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      bot_id: ctx.bot.id,
      delivered: 0,
      last_delivery_at: null,
      runs: 0,
      median_wait_seconds: null,
    });
    expect(r.body.days).toHaveLength(14);
    expect(r.body.days.every((d: { delivered: number }) => d.delivered === 0)).toBe(true);
  });

  it("counts days, runs and median wait, with a day that has none", async () => {
    const ctx = await setup();
    const noon = (offset: number) => dayStart(offset) + 12 * 3_600_000;
    // Three days ago: one run of one message.
    await deliver(ctx, "a", noon(3), 100);
    // Two days ago: thread a delivers two messages at once (one run), thread b one (another run).
    await deliver(ctx, "a", noon(2), 10);
    await deliver(ctx, "a", noon(2), 30);
    await deliver(ctx, "b", noon(2), 20);
    // Today, thread a again: a later run in the same thread.
    await deliver(ctx, "a", dayStart(0), 40);
    const r = (await call("GET", `/bots/${ctx.bot.id}/activity?days=5`, { key: ctx.key })).body;
    expect(r.days).toEqual([
      { date: date(4), delivered: 0 },
      { date: date(3), delivered: 1 },
      { date: date(2), delivered: 3 },
      { date: date(1), delivered: 0 },
      { date: date(0), delivered: 1 },
    ]);
    expect(r.delivered).toBe(5);
    expect(r.runs).toBe(4);
    // Waits 100, 10, 30, 20, 40: the median is 30.
    expect(r.median_wait_seconds).toBeCloseTo(30, 3);
    expect(r.last_delivery_at).toBe(new Date(dayStart(0)).toISOString());
  });

  it("includes the first day of the window and leaves out the millisecond before it", async () => {
    const ctx = await setup();
    await deliver(ctx, "a", dayStart(2), 10);
    await deliver(ctx, "a", dayStart(3) - 1, 500);
    const r = (await call("GET", `/bots/${ctx.bot.id}/activity?days=3`, { key: ctx.key })).body;
    expect(r.days[0]).toEqual({ date: date(2), delivered: 1 });
    expect(r.delivered).toBe(1);
    expect(r.runs).toBe(1);
    expect(r.median_wait_seconds).toBeCloseTo(10, 3);
  });

  it("reports the last delivery even when it is older than the window", async () => {
    const ctx = await setup();
    const at = dayStart(40) + 3_600_000;
    await deliver(ctx, "a", at);
    const r = (await call("GET", `/bots/${ctx.bot.id}/activity`, { key: ctx.key })).body;
    expect(r).toMatchObject({ delivered: 0, runs: 0, median_wait_seconds: null });
    expect(r.last_delivery_at).toBe(new Date(at).toISOString());
  });

  it("lists every bot of the user, and only theirs", async () => {
    const ctx = await setup();
    const other = await setup();
    await deliver(ctx, "a", dayStart(0));
    await deliver(other, "a", dayStart(0));
    const second = (
      await call("POST", "/bots", { key: ctx.key, body: { name: "c", model: "sonnet", inbox_ids: [ctx.inbox.id] } })
    ).body;
    const list = (await call("GET", "/bots/activity?days=7", { key: ctx.key })).body.data;
    expect(list.map((a: { bot_id: string }) => a.bot_id).sort()).toEqual([ctx.bot.id, second.id].sort());
    expect(list.find((a: { bot_id: string }) => a.bot_id === ctx.bot.id).delivered).toBe(1);
    expect(list.find((a: { bot_id: string }) => a.bot_id === second.id).delivered).toBe(0);
    expect(list[0].days).toHaveLength(7);
  });

  it("hides another user's bot", async () => {
    const mine = await setup();
    const other = await newUser("Other");
    await deliver(mine, "a", dayStart(0));
    expect((await call("GET", `/bots/${mine.bot.id}/activity`, { key: other })).status).toBe(404);
    expect((await call("GET", "/bots/activity", { key: other })).body.data).toEqual([]);
  });

  it("rejects days outside 1..30 rather than clamping", async () => {
    const ctx = await setup();
    for (const days of ["0", "31", "-1", "x", "1.5"]) {
      expect((await call("GET", `/bots/activity?days=${days}`, { key: ctx.key })).status, days).toBe(400);
      expect((await call("GET", `/bots/${ctx.bot.id}/activity?days=${days}`, { key: ctx.key })).status, days).toBe(400);
    }
    expect((await call("GET", "/bots/activity?days=30", { key: ctx.key })).body.data[0].days).toHaveLength(30);
    expect((await call("GET", "/bots/activity?days=1", { key: ctx.key })).body.data[0].days).toHaveLength(1);
  });
});
