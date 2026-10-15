import { describe, expect, it } from "vitest";
import { windowStart } from "../../../sources/src/schedule.js";
import { createApi } from "../../src/api.js";
import { app, call, db, newUser } from "../helpers.js";

const CRON = "cron-secret";
const cronApp = () => createApi({ getDb: async () => db, tokenSecret: "x", cronSecret: CRON });
const tick = (token: string | null = CRON, a = cronApp()) =>
  a.request("/api/cron/schedules", { headers: token ? { authorization: `Bearer ${token}` } : {} });

const config = {
  schedule: { every: "hour" },
  messages: [
    { type: "standup", message: "Write the standup" },
    { type: "water", message: "Drink water" },
  ],
};

function scheduleInbox(key: string, c: unknown = config) {
  return call("POST", "/inboxes", { key, body: { name: "clock", source_type: "schedule", config: c } });
}

describe("schedule inboxes", () => {
  it("computes the window an hourly or daily schedule is in", () => {
    const at = new Date("2026-10-15T11:15:30Z");
    expect(windowStart({ every: "hour" }, at).toISOString()).toBe("2026-10-15T11:00:00.000Z");
    expect(windowStart({ every: "day", hour: 9 }, at).toISOString()).toBe("2026-10-15T09:00:00.000Z");
    expect(windowStart({ every: "day", hour: 13 }, at).toISOString()).toBe("2026-10-14T13:00:00.000Z");
  });

  it("validates its config", async () => {
    const key = await newUser();
    expect((await scheduleInbox(key, {})).status).toBe(400);
    expect((await scheduleInbox(key, { ...config, schedule: { every: "week" } })).status).toBe(400);
    expect((await scheduleInbox(key, { ...config, schedule: { every: "day", hour: 24 } })).status).toBe(400);
    expect((await scheduleInbox(key, { ...config, messages: [] })).status).toBe(400);
    expect((await scheduleInbox(key, { ...config, messages: [config.messages[0], config.messages[0]] })).status).toBe(
      400,
    );
    const ok = await scheduleInbox(key);
    expect(ok.status).toBe(201);
    expect(ok.body.config).toEqual(config);
  });

  it("stores one message per type per window, and a second run in the window is a duplicate", async () => {
    const key = await newUser();
    const inbox = (await scheduleInbox(key)).body;
    const first = await (await tick()).json();
    expect(first.accepted).toBeGreaterThanOrEqual(2);
    const again = await (await tick()).json();
    expect(again.accepted).toBe(0);
    expect(again.duplicate).toBeGreaterThanOrEqual(2);

    const messages = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data;
    expect(messages).toHaveLength(2);
    const event = messages.find((m: { event: { type: string } }) => m.event.type.endsWith(".water")).event;
    expect(event.type).toBe("dev.craftmill.loopway.schedule.water");
    expect(event.subject).toBe(event.id);
    expect(event.data.message).toBe("Drink water");
    expect(event.data.created_at).toBe(event.time);
    expect(new Date(event.time).getUTCMinutes()).toBe(0);
  });

  it("stamps a daily schedule's messages with its hour", async () => {
    const key = await newUser();
    const inbox = (await scheduleInbox(key, { schedule: { every: "day", hour: 9 }, messages: [config.messages[0]] }))
      .body;
    await tick();
    const [m] = (await call("GET", `/inboxes/${inbox.id}/messages`, { key })).body.data;
    expect(new Date(m.event.time).getUTCHours()).toBe(9);
    expect(new Date(m.event.time).getUTCMinutes()).toBe(0);
  });

  it("keeps going when one inbox's config no longer parses", async () => {
    const key = await newUser();
    const broken = (await scheduleInbox(key)).body;
    await db.query(`UPDATE loopway.inboxes SET config = '{}'::jsonb WHERE id = $1`, [broken.id]);
    const good = (await scheduleInbox(key)).body;
    const result = await (await tick()).json();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const messages = (await call("GET", `/inboxes/${good.id}/messages`, { key })).body.data;
    expect(messages).toHaveLength(2);
  });

  it("refuses the cron route without the secret", async () => {
    expect((await tick(null)).status).toBe(401);
    expect((await tick("wrong")).status).toBe(401);
    expect((await tick(CRON, createApi({ getDb: async () => db, tokenSecret: "x" }))).status).toBe(401);
  });

  it("takes no webhooks", async () => {
    const key = await newUser();
    const inbox = (await scheduleInbox(key)).body;
    const r = await app.request(`/api/webhooks/${inbox.id}`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });
});
