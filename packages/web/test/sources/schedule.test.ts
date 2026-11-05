import { randomUUID } from "node:crypto";
import { TEST_INBOX_KEY } from "../../src/db/testing.js";
import { describe, expect, it } from "vitest";
import { windowStart } from "../../../sources/src/schedule.js";
import { createApi, parseScheduleOptions } from "../../src/api.js";
import type { Metrics } from "../../src/metrics.js";
import { app, call, db, newUser, readAll, SECRET, userId } from "../helpers.js";

const CRON = "cron-secret";
const cronApp = () =>
  createApi({ getDb: async () => db, tokenSecret: "x", inboxSecretKey: TEST_INBOX_KEY, cronSecret: CRON });
const tick = (token: string | null = CRON, a = cronApp()) =>
  a.request("/api/cron/tick", { headers: token ? { authorization: `Bearer ${token}` } : {} });

const config = {
  schedule: { every: "hour" },
  messages: [
    { type: "standup", message: "Write the standup" },
    { type: "water", message: "Drink water" },
  ],
};

/** Source names are unique per user, and these tests register several. */
const clock = () => `clock-${randomUUID()}`;

function scheduleSource(key: string, c: unknown = config) {
  return call("POST", "/sources", { key, body: { type: "schedule", name: clock(), config: c } });
}

describe("schedule sources", () => {
  it("computes the window a weekly schedule is in", () => {
    const week = (day: number, hour: number, at: string) =>
      windowStart({ every: "week", day, hour }, new Date(at)).toISOString();
    // 2026-10-14 is a Wednesday; the Monday 13:00 window starts 2026-10-12.
    expect(week(1, 13, "2026-10-14T08:00:00Z")).toBe("2026-10-12T13:00:00.000Z");
    expect(week(1, 13, "2026-10-18T23:59:59Z")).toBe("2026-10-12T13:00:00.000Z");
    // The boundary hour opens the window; a tick just before it is still in the last one.
    expect(week(1, 13, "2026-10-19T13:00:00Z")).toBe("2026-10-19T13:00:00.000Z");
    expect(week(1, 13, "2026-10-19T12:59:59Z")).toBe("2026-10-12T13:00:00.000Z");
    // Sunday (0) and Saturday (6).
    expect(week(0, 0, "2026-10-14T08:00:00Z")).toBe("2026-10-11T00:00:00.000Z");
    expect(week(6, 23, "2026-10-14T08:00:00Z")).toBe("2026-10-10T23:00:00.000Z");
  });

  it("computes the window an hourly or daily schedule is in", () => {
    const at = new Date("2026-10-15T11:15:30Z");
    expect(windowStart({ every: "hour" }, at).toISOString()).toBe("2026-10-15T11:00:00.000Z");
    expect(windowStart({ every: "day", hour: 9 }, at).toISOString()).toBe("2026-10-15T09:00:00.000Z");
    expect(windowStart({ every: "day", hour: 13 }, at).toISOString()).toBe("2026-10-14T13:00:00.000Z");
  });

  it("validates its config", async () => {
    const key = await newUser();
    expect((await scheduleSource(key, {})).status).toBe(400);
    expect((await scheduleSource(key, { ...config, schedule: { every: "week" } })).status).toBe(400);
    expect((await scheduleSource(key, { ...config, schedule: { every: "week", hour: 9 } })).status).toBe(400);
    expect((await scheduleSource(key, { ...config, schedule: { every: "week", day: 7, hour: 9 } })).status).toBe(400);
    expect((await scheduleSource(key, { ...config, schedule: { every: "week", day: 1, hour: 24 } })).status).toBe(400);
    expect((await scheduleSource(key, { ...config, schedule: { every: "month" } })).status).toBe(400);
    expect((await scheduleSource(key, { ...config, schedule: { every: "day", hour: 24 } })).status).toBe(400);
    expect((await scheduleSource(key, { ...config, messages: [] })).status).toBe(400);
    expect((await scheduleSource(key, { ...config, messages: [config.messages[0], config.messages[0]] })).status).toBe(
      400,
    );
    const ok = await scheduleSource(key);
    expect(ok.status).toBe(201);
    expect(ok.body.config).toEqual(config);
  });

  it("accepts a weekly schedule and stores one message for the week", async () => {
    const key = await newUser();
    const weekly = { schedule: { every: "week", day: 1, hour: 13 }, messages: [config.messages[0]] };
    const source = await scheduleSource(key, weekly);
    expect(source.status).toBe(201);
    expect(source.body.config).toEqual(weekly);
    await tick();
    await tick();
    const messages = await readAll(key);
    expect(messages).toHaveLength(1);
    const time = new Date(messages[0]!.event.time);
    expect(time.getUTCDay()).toBe(1);
    expect(time.getUTCHours()).toBe(13);
  });

  it("stores one message per type per window, and a second run in the window is a duplicate", async () => {
    const key = await newUser();
    const source = (await scheduleSource(key)).body;
    const first = await (await tick()).json();
    expect(Object.keys(first).sort()).toEqual(["accepted", "disabled", "duplicate", "failed", "purged", "sources"]);
    expect(first.accepted).toBeGreaterThanOrEqual(2);
    const again = await (await tick()).json();
    expect(again.accepted).toBe(0);
    expect(again.duplicate).toBeGreaterThanOrEqual(2);

    const messages = await readAll(key);
    expect(messages).toHaveLength(2);
    const event = messages.find((m) => m.event.type.endsWith(".water"))!.event;
    expect(event.type).toBe("dev.craftmill.loopway.schedule.water");
    expect(event.source).toBe(`urn:loopway:source:${source.id}`);
    expect(event.subject).toBe(event.id);
    expect(event.data).toEqual({ message: "Drink water", created_at: event.time });
    expect(new Date(event.time).getUTCMinutes()).toBe(0);
  });

  it("stamps a daily schedule's messages with its hour", async () => {
    const key = await newUser();
    await scheduleSource(key, { schedule: { every: "day", hour: 9 }, messages: [config.messages[0]] });
    await tick();
    const [m] = await readAll(key);
    expect(new Date(m!.event.time).getUTCHours()).toBe(9);
    expect(new Date(m!.event.time).getUTCMinutes()).toBe(0);
  });

  it("keeps going when one source's config no longer parses", async () => {
    const key = await newUser();
    const broken = (await scheduleSource(key)).body;
    await db.query(`UPDATE loopway.sources SET config = '{}'::jsonb WHERE id = $1`, [broken.id]);
    const good = (await scheduleSource(key)).body;
    const result = await (await tick()).json();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const messages = (await readAll(key)).filter((m) => m.source_id === good.id);
    expect(messages).toHaveLength(2);
  });

  it("refuses the cron route without the secret", async () => {
    expect((await tick(null)).status).toBe(401);
    expect((await tick("wrong")).status).toBe(401);
    expect(
      (await tick(CRON, createApi({ getDb: async () => db, tokenSecret: "x", inboxSecretKey: TEST_INBOX_KEY }))).status,
    ).toBe(401);
  });

  it("takes no webhooks", async () => {
    const key = await newUser();
    const source = (await scheduleSource(key)).body;
    expect(source).not.toHaveProperty("webhook_url");
    const r = await app.request(`/api/webhooks/${await userId(key)}`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe("unverified");
  });

  it("has no secret", async () => {
    const key = await newUser();
    const body = { type: "schedule", name: clock(), config, secret: "x".repeat(32) };
    expect((await call("POST", "/sources", { key, body })).status).toBe(400);
  });

  describe("schedule options", () => {
    const events: { event: string; properties?: Record<string, unknown> }[] = [];
    const metrics: Metrics = { capture: async (event, _id, properties) => void events.push({ event, properties }) };
    const dayOnly = () =>
      createApi({
        getDb: async () => db,
        tokenSecret: SECRET,
        inboxSecretKey: TEST_INBOX_KEY,
        cronSecret: CRON,
        scheduleOptions: ["day"],
        metrics,
      });
    const daily = { schedule: { every: "day", hour: 9 }, messages: [config.messages[0]] };

    it("reads SCHEDULE_OPTIONS, defaulting to day and week", () => {
      expect(parseScheduleOptions(undefined)).toEqual(["day", "week"]);
      expect(parseScheduleOptions("")).toEqual(["day", "week"]);
      expect(parseScheduleOptions("week,day,hour")).toEqual(["hour", "day", "week"]);
      expect(parseScheduleOptions(" hour ")).toEqual(["hour"]);
      expect(() => parseScheduleOptions("month")).toThrow(/month/);
    });

    it("lists the enabled options with the source types", async () => {
      const key = await newUser();
      expect((await call("GET", "/source-types", { key })).body.schedule_options).toEqual(["hour", "day", "week"]);
      const r = await dayOnly().request("/api/source-types", { headers: { authorization: `Bearer ${key}` } });
      expect((await r.json()).schedule_options).toEqual(["day"]);
    });

    it("rejects registering or updating a source with a disabled option", async () => {
      const key = await newUser();
      const post = (body: unknown) =>
        dayOnly().request("/api/sources", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      events.length = 0;
      const hourly = await post({ type: "schedule", name: clock(), config });
      expect(hourly.status).toBe(400);
      expect((await hourly.json()).error.code).toBe("schedule_option_disabled");
      expect(events).toContainEqual({
        event: "schedule_option_rejected",
        properties: { option: "hour", action: "create" },
      });
      expect((await post({ type: "schedule", name: clock(), config: daily })).status).toBe(201);

      const source = (await scheduleSource(key, daily)).body;
      const patch = await dayOnly().request(`/api/sources/${source.id}`, {
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

    it("lets a source on a disabled option keep it while its messages change", async () => {
      const key = await newUser();
      const source = (await scheduleSource(key)).body;
      const messages = [{ type: "standup", message: "New text" }];
      const patch = await dayOnly().request(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ config: { schedule: { every: "hour" }, messages } }),
      });
      expect(patch.status).toBe(200);
    });

    it("accepts both options when both are on", async () => {
      const key = await newUser();
      expect((await scheduleSource(key)).status).toBe(201);
      expect((await scheduleSource(key, daily)).status).toBe(201);
    });

    it("skips sources on a disabled option at a cron tick and records it", async () => {
      const key = await newUser();
      const hourly = (await scheduleSource(key)).body;
      const dailySource = (await scheduleSource(key, daily)).body;
      events.length = 0;
      const result = await (await tick(CRON, dayOnly())).json();
      expect(result.disabled).toBeGreaterThanOrEqual(1);
      expect(events.filter((e) => e.event === "schedule_tick_rejected")).toContainEqual({
        event: "schedule_tick_rejected",
        properties: { reason: "option_disabled", option: "hour" },
      });
      const messages = await readAll(key);
      expect(messages.filter((m) => m.source_id === hourly.id)).toHaveLength(0);
      expect(messages.filter((m) => m.source_id === dailySource.id)).toHaveLength(1);
    });
  });
});
