import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { type Db } from "../src/db/index.js";
import { openTestDb, TEST_INBOX_KEY } from "../src/db/testing.js";
import { createLoginCode } from "../src/store.js";
import { createMetrics, noopMetrics, type Metrics } from "../src/metrics.js";

let db: Db;
let app: ReturnType<typeof createApi>;
const events: { event: string; distinctId: string; properties?: Record<string, unknown> }[] = [];
const metrics: Metrics = {
  capture: async (event, distinctId, properties) => void events.push({ event, distinctId, properties }),
};

beforeAll(async () => {
  db = await openTestDb();
  app = createApi({ getDb: async () => db, tokenSecret: "test-secret", inboxSecretKey: TEST_INBOX_KEY, metrics });
});
afterAll(() => db.close());

describe("metrics", () => {
  it("counts API errors by code", async () => {
    const res = await app.request("/api/inboxes");
    expect(res.status).toBe(401);
    expect(events.at(-1)).toMatchObject({
      event: "api_error",
      distinctId: "anonymous",
      properties: { code: "unauthorized", status: 401 },
    });
  });

  it("sets the person's email and name on signup and on login", async () => {
    const email = "metrics-person@example.com";
    const verify = async (body: Record<string, unknown>) => {
      const { code } = await createLoginCode(db, email);
      return app.request("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code, ...body }),
      });
    };
    const signup = await verify({ username: "metrics-person" });
    expect(signup.status).toBe(201);
    const { user } = await signup.json();
    expect(events.find((e) => e.event === "signed_up" && e.distinctId === user.id)?.properties).toMatchObject({
      $set: { email, name: user.name },
      client: "web",
    });
    expect((await verify({})).status).toBe(201);
    expect(events.findLast((e) => e.event === "logged_in" && e.distinctId === user.id)?.properties).toMatchObject({
      $set: { email, name: user.name },
    });
  });

  it("counts a webhook for an unknown inbox as an error", async () => {
    const res = await app.request("/api/webhooks/00000000-0000-7000-8000-000000000000", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(events.at(-1)).toMatchObject({ event: "api_error", properties: { code: "not_found", status: 404 } });
  });

  it("gives the browser the PostHog key only when one is set", async () => {
    const without = await (await app.request("/dashboard")).text();
    expect(without).not.toContain("posthog-key");
    const keyed = createApi({
      getDb: async () => db,
      tokenSecret: "test-secret",
      inboxSecretKey: TEST_INBOX_KEY,
      posthogKey: "phc_test",
    });
    expect(await (await keyed.request("/dashboard")).text()).toContain('<meta name="posthog-key" content="phc_test">');
    expect(await (await keyed.request("/dashboard")).text()).toContain('content="https://us.posthog.com"');
  });

  it("records nothing without a PostHog key", () => {
    expect(createMetrics({})).toBe(noopMetrics);
  });
});
