import { describe, expect, it } from "vitest";
import { windowStart } from "../../../sources/src/schedule.js";
import { createApi, parseScheduleOptions } from "../../src/api.js";
import type { Metrics } from "../../src/metrics.js";
import { app, call, db, newUser, SECRET } from "../helpers.js";

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

  describe("schedule options", () => {
    const events: { event: string; properties?: Record<string, unknown> }[] = [];
    const metrics: Metrics = { capture: async (event, _id, properties) => void events.push({ event, properties }) };
    const dayOnly = () =>
      createApi({ getDb: async () => db, tokenSecret: SECRET, cronSecret: CRON, scheduleOptions: ["day"], metrics });
    const daily = { schedule: { every: "day", hour: 9 }, messages: [config.messages[0]] };

    it("reads SCHEDULE_OPTIONS, defaulting to day", () => {
      expect(parseScheduleOptions(undefined)).toEqual(["day"]);
      expect(parseScheduleOptions("")).toEqual(["day"]);
      expect(parseScheduleOptions("day,hour")).toEqual(["hour", "day"]);
      expect(parseScheduleOptions(" hour ")).toEqual(["hour"]);
      expect(() => parseScheduleOptions("week")).toThrow(/week/);
    });

    it("lists the enabled options with the sources", async () => {
      const key = await newUser();
      expect((await call("GET", "/sources", { key })).body.schedule_options).toEqual(["hour", "day"]);
      const r = await dayOnly().request("/api/sources", { headers: { authorization: `Bearer ${key}` } });
      expect((await r.json()).schedule_options).toEqual(["day"]);
    });

    it("rejects creating or updating an inbox with a disabled option", async () => {
      const key = await newUser();
      const post = (body: unknown) =>
        dayOnly().request("/api/inboxes", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const org = (await call("GET", "/orgs", { key })).body.data.find((o: { personal: boolean }) => o.personal).slug;
      events.length = 0;
      const hourly = await post({ org, name: "clock", source_type: "schedule", config });
      expect(hourly.status).toBe(400);
      expect((await hourly.json()).error.code).toBe("schedule_option_disabled");
      expect(events).toContainEqual({
        event: "schedule_option_rejected",
        properties: { option: "hour", action: "create" },
      });
      expect((await post({ org, name: "clock", source_type: "schedule", config: daily })).status).toBe(201);

      const inbox = (await scheduleInbox(key, daily)).body;
      const patch = await dayOnly().request(`/api/inboxes/${inbox.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ config }),
      });
      expect(patch.status).toBe(400);
      expect(events).toContainEqual({
        event: "schedule_option_rejected",
        properties: { option: "hour", action: "update" },
      });
    });

    it("lets an inbox on a disabled option keep it while its messages change", async () => {
      const key = await newUser();
      const inbox = (await scheduleInbox(key)).body;
      const messages = [{ type: "standup", message: "New text" }];
      const patch = await dayOnly().request(`/api/inboxes/${inbox.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ config: { schedule: { every: "hour" }, messages } }),
      });
      expect(patch.status).toBe(200);
    });

    it("accepts both options when both are on", async () => {
      const key = await newUser();
      expect((await scheduleInbox(key)).status).toBe(201);
      expect((await scheduleInbox(key, daily)).status).toBe(201);
    });

    it("skips inboxes on a disabled option at a cron tick and records it", async () => {
      const key = await newUser();
      const hourly = (await scheduleInbox(key)).body;
      const dailyInbox = (await scheduleInbox(key, daily)).body;
      events.length = 0;
      const result = await (await tick(CRON, dayOnly())).json();
      expect(result.disabled).toBeGreaterThanOrEqual(1);
      expect(events.filter((e) => e.event === "schedule_tick_rejected")).toEqual([
        { event: "schedule_tick_rejected", properties: { reason: "option_disabled", option: "hour" } },
      ]);
      expect((await call("GET", `/inboxes/${hourly.id}/messages`, { key })).body.data).toHaveLength(0);
      expect((await call("GET", `/inboxes/${dailyInbox.id}/messages`, { key })).body.data).toHaveLength(1);
    });
  });
});
