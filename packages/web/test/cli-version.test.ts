import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { MIN_CLI_VERSION_FLOOR, minCliVersion, olderThan } from "../src/cli-version.js";
import { type Db } from "../src/db/index.js";
import { openTestDb, TEST_INBOX_KEY } from "../src/db/testing.js";
import { createUser } from "../src/store.js";
import { signSessionToken } from "../src/tokens.js";
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

describe("minCliVersion", () => {
  it("is the floor in code when the env var is unset, empty or not a version", () => {
    expect(minCliVersion(undefined)).toBe(MIN_CLI_VERSION_FLOOR);
    expect(minCliVersion("")).toBe(MIN_CLI_VERSION_FLOOR);
    expect(minCliVersion("soon")).toBe(MIN_CLI_VERSION_FLOOR);
  });
  it("lets the env var raise the minimum but not lower it", () => {
    expect(minCliVersion("0.1.0", "0.3.37")).toBe("0.3.37");
    expect(minCliVersion("0.3.37", "0.3.37")).toBe("0.3.37");
    expect(minCliVersion("0.4.0", "0.3.37")).toBe("0.4.0");
    expect(minCliVersion(" 0.10.0 ", "0.9.0")).toBe("0.10.0");
  });
});

describe("the floor in code", () => {
  it("turns away the last CLI that leased bots, and serves the release that stopped", async () => {
    const db = await openTestDb();
    const app = createApi({
      getDb: async () => db,
      tokenSecret: "test-secret",
      inboxSecretKey: TEST_INBOX_KEY,
      minCliVersion: minCliVersion(undefined),
    });
    const get = (version?: string) =>
      app.request("/api/health", { headers: version ? { "x-loopway-cli-version": version } : {} });
    expect((await get("0.3.54")).status).toBe(426);
    expect((await get("0.4.0")).status).toBe(200);
    expect((await get()).status).toBe(200);
    // An env value below the floor can't let 0.3.53 back in; one above it raises the minimum.
    const lowered = createApi({
      getDb: async () => db,
      tokenSecret: "test-secret",
      inboxSecretKey: TEST_INBOX_KEY,
      minCliVersion: minCliVersion("0.2.0"),
    });
    expect((await lowered.request("/api/health", { headers: { "x-loopway-cli-version": "0.3.53" } })).status).toBe(426);
    await db.close();
  });
});

describe("minimum CLI version", () => {
  let db: Db;
  const events: { event: string; distinctId: string; properties?: Record<string, unknown> }[] = [];
  const metrics: Metrics = {
    capture: async (event, distinctId, properties) => void events.push({ event, distinctId, properties }),
  };
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

  it("counts the rejection under the user whose token came with it, and names the path", async () => {
    const { user } = await createUser(db, { name: "Outdated" });
    const { token } = signSessionToken(user.id, "test-secret");
    const res = await app.request(`/api/inboxes/${user.id}/messages`, {
      headers: { "x-loopway-cli-version": "0.1.0", authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(426);
    expect(events.at(-1)).toMatchObject({
      event: "api_error",
      distinctId: user.id,
      properties: { code: "cli_outdated", path: "/api/inboxes/:id/messages" },
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
