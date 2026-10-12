import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { migrate, openDb, type Db } from "../src/db/index.js";
import { createMetrics, noopMetrics, type Metrics } from "../src/metrics.js";

let db: Db;
let app: ReturnType<typeof createApi>;
const events: { event: string; distinctId: string; properties?: Record<string, unknown> }[] = [];
const metrics: Metrics = {
  capture: async (event, distinctId, properties) => void events.push({ event, distinctId, properties }),
};

beforeAll(async () => {
  db = await openDb({ pgliteDir: "memory://" });
  await migrate(db);
  app = createApi({ getDb: async () => db, tokenSecret: "test-secret", metrics });
});
afterAll(() => db.close());

describe("metrics", () => {
  it("counts API errors by code", async () => {
    const res = await app.request("/inboxes");
    expect(res.status).toBe(401);
    expect(events.at(-1)).toMatchObject({
      event: "api_error",
      distinctId: "anonymous",
      properties: { code: "unauthorized", status: 401 },
    });
  });

  it("counts a webhook for an unknown inbox as an error", async () => {
    const res = await app.request("/webhooks/00000000-0000-7000-8000-000000000000", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(events.at(-1)).toMatchObject({ event: "api_error", properties: { code: "not_found", status: 404 } });
  });

  it("gives the browser the PostHog key only when one is set", async () => {
    const without = await (await app.request("/dashboard")).text();
    expect(without).not.toContain("posthog-key");
    const keyed = createApi({ getDb: async () => db, tokenSecret: "test-secret", posthogKey: "phc_test" });
    expect(await (await keyed.request("/dashboard")).text()).toContain('<meta name="posthog-key" content="phc_test">');
    expect(await (await keyed.request("/dashboard")).text()).toContain('content="https://us.posthog.com"');
  });

  it("records nothing without a PostHog key", () => {
    expect(createMetrics({})).toBe(noopMetrics);
  });
});
