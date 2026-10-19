import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { olderThan } from "../src/cli-version.js";
import { type Db } from "../src/db/index.js";
import { openTestDb, TEST_INBOX_KEY } from "../src/db/testing.js";
import { createWeb } from "../src/ui.js";
import type { Metrics } from "../src/metrics.js";

describe("olderThan", () => {
  it("compares numerically, not as text", () => {
    expect(olderThan("0.9.0", "0.10.0")).toBe(true);
    expect(olderThan("1.0.0", "0.10.0")).toBe(false);
    expect(olderThan("0.2.0", "0.2.0")).toBe(false);
  });
  it("turns nobody away for a minimum that isn't a version", () => {
    expect(olderThan("0.1.0", "soon")).toBe(false);
  });
});

describe("minimum CLI version", () => {
  let db: Db;
  const events: { event: string; properties?: Record<string, unknown> }[] = [];
  const metrics: Metrics = { capture: async (event, _id, properties) => void events.push({ event, properties }) };
  let app: ReturnType<typeof createApi>;
  beforeAll(async () => {
    db = await openTestDb();
    app = createApi({
      getDb: async () => db,
      tokenSecret: "test-secret",
      inboxSecretKey: TEST_INBOX_KEY,
      publicBaseUrl: "https://loopway.test",
      minCliVersion: "0.2.0",
      metrics,
    });
  });
  afterAll(() => db.close());

  const get = (version?: string) =>
    app.request("/api/health", { headers: version ? { "x-loopway-cli-version": version } : {} });

  it("turns away an older CLI with a way to update, and counts it by version", async () => {
    const res = await get("0.1.0");
    expect(res.status).toBe(426);
    const { error } = await res.json();
    expect(error.code).toBe("cli_outdated");
    expect(error.message).toContain("https://loopway.test/install.sh");
    expect(events.at(-1)).toMatchObject({
      event: "api_error",
      properties: { code: "cli_outdated", status: 426, cli_version: "0.1.0" },
    });
  });

  it("serves the minimum version, newer ones and requests that name no CLI", async () => {
    expect((await get("0.2.0")).status).toBe(200);
    expect((await get("1.4.0-beta.1")).status).toBe(200);
    expect((await get()).status).toBe(200);
  });

  it("labels errors with a version only when it looks like one", async () => {
    await app.request("/api/me", { headers: { "x-loopway-cli-version": "0.3.1" } });
    expect(events.at(-1)?.properties).toMatchObject({ code: "unauthorized", cli_version: "0.3.1" });
    await app.request("/api/me", { headers: { "x-loopway-cli-version": "evil@example.com" } });
    expect(events.at(-1)?.properties).toMatchObject({ cli_version: "unknown" });
    await app.request("/api/me");
    expect(events.at(-1)?.properties).toMatchObject({ cli_version: "none" });
  });
});

describe("GET /install.sh", () => {
  it("serves the install script and counts it", async () => {
    const captured: string[] = [];
    const web = createWeb({ metrics: { capture: async (event) => void captured.push(event) } });
    const res = await web.request("/install.sh");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^#!\/bin\/sh/);
    expect(body).toContain("releases");
    expect(captured).toEqual(["install_sh_served"]);
  });
});
