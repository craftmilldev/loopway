import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrationUrl, runMigrations } from "../src/db/run-migrations.js";
import { connectionUrl, serverUrl } from "../src/db/index.js";
import { createTestDatabase, TEST_INBOX_KEY } from "../src/db/testing.js";
import { migrations } from "../src/db/migrations.js";
import type { Metrics } from "../src/metrics.js";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let raceDatabase: typeof database;

const events: { event: string; properties?: Record<string, unknown> }[] = [];
const metrics: Metrics = { capture: async (event, _id, properties) => void events.push({ event, properties }) };
const lines: string[] = [];
const log = (l: string) => void lines.push(l);

beforeAll(async () => {
  database = await createTestDatabase();
  raceDatabase = await createTestDatabase();
});
afterAll(async () => {
  await database.drop();
  await raceDatabase.drop();
});
afterEach(() => {
  events.length = 0;
  lines.length = 0;
});

describe("migrationUrl", () => {
  it("prefers DATABASE_URL_UNPOOLED, then DATABASE_URL, and never the pooled URL", () => {
    expect(migrationUrl({ DATABASE_URL_UNPOOLED: "u", DATABASE_URL: "d", DATABASE_URL_POOLED: "p" })).toBe("u");
    expect(migrationUrl({ DATABASE_URL: "d", DATABASE_URL_POOLED: "p" })).toBe("d");
    expect(migrationUrl({ DATABASE_URL_POOLED: "p" })).toBeUndefined();
    expect(migrationUrl({ DATABASE_URL_UNPOOLED: "", DATABASE_URL: "d" })).toBe("d");
  });

  it("falls back to Supabase's session-mode URL, never its transaction pooler", () => {
    expect(migrationUrl({ POSTGRES_URL_NON_POOLING: "s", POSTGRES_URL: "t" })).toBe("s");
    expect(migrationUrl({ POSTGRES_URL: "t" })).toBeUndefined();
    expect(migrationUrl({ DATABASE_URL: "d", POSTGRES_URL_NON_POOLING: "s" })).toBe("d");
  });
});

describe("serverUrl", () => {
  it("prefers DATABASE_URL_POOLED, then DATABASE_URL, then Supabase's POSTGRES_URL", () => {
    expect(serverUrl({ DATABASE_URL_POOLED: "p", DATABASE_URL: "d", POSTGRES_URL: "t" })).toBe("p");
    expect(serverUrl({ DATABASE_URL: "d", POSTGRES_URL: "t" })).toBe("d");
    expect(serverUrl({ POSTGRES_URL: "t", POSTGRES_URL_NON_POOLING: "s" })).toBe("t");
    expect(serverUrl({})).toBeUndefined();
  });
});

describe("connectionUrl", () => {
  it("drops the params Vercel's Supabase integration and libpq add, keeps sslmode", () => {
    const u = connectionUrl(
      ' "postgres://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x&pgbouncer=true&channel_binding=require" ',
    );
    expect(u).toBe("postgres://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require");
  });
});

describe("runMigrations", () => {
  it("applies pending migrations, then is a no-op", async () => {
    const env = { DATABASE_URL: database.url, INBOX_SECRET_KEY: TEST_INBOX_KEY };
    const first = await runMigrations({ env, metrics, log });
    expect(first).toEqual(migrations.map((m) => m.version));
    expect(events).toEqual([{ event: "migrations_applied", properties: { count: migrations.length } }]);

    events.length = 0;
    expect(await runMigrations({ env, metrics, log })).toEqual([]);
    expect(events).toEqual([{ event: "migrations_applied", properties: { count: 0 } }]);
    expect(lines.at(-1)).toBe("Migrations up to date.");
  });

  it("fails the build when INBOX_SECRET_KEY is unset", async () => {
    const env = { DATABASE_URL: database.url };
    await expect(runMigrations({ env, metrics, log })).rejects.toThrow(/INBOX_SECRET_KEY/);
    expect(events.map((e) => e.event)).toEqual(["migrations_failed"]);
  });

  it("migrates the unpooled URL when DATABASE_URL is the pooled one", async () => {
    const env = {
      DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
      DATABASE_URL_UNPOOLED: database.url,
      INBOX_SECRET_KEY: TEST_INBOX_KEY,
    };
    expect(await runMigrations({ env, metrics, log })).toEqual([]);
  });

  it("records migrations_failed and rethrows when the database can't be migrated", async () => {
    const env = { DATABASE_URL_UNPOOLED: "postgres://nobody@127.0.0.1:1/none", INBOX_SECRET_KEY: TEST_INBOX_KEY };
    await expect(runMigrations({ env, metrics, log })).rejects.toThrow();
    expect(events.map((e) => e.event)).toEqual(["migrations_failed"]);
  });

  it("records migrations_failed when a migration's SQL fails", async () => {
    const env = { DATABASE_URL: database.url, INBOX_SECRET_KEY: TEST_INBOX_KEY };
    migrations.push({ version: "999_broken", sql: "SELECT * FROM loopway.no_such_table" });
    try {
      await expect(runMigrations({ env, metrics, log })).rejects.toThrow();
    } finally {
      migrations.pop();
    }
    expect(events.map((e) => e.event)).toEqual(["migrations_failed"]);
  });

  it("lets two concurrent runs take turns, applying each migration once", async () => {
    const env = { DATABASE_URL: raceDatabase.url, INBOX_SECRET_KEY: TEST_INBOX_KEY };
    const [a, b] = await Promise.all([runMigrations({ env, metrics, log }), runMigrations({ env, metrics, log })]);
    expect([...a!, ...b!].sort()).toEqual(migrations.map((m) => m.version).sort());
  });

  it("skips when no URL is set", async () => {
    expect(await runMigrations({ env: {}, metrics, log })).toBeNull();
    expect(events).toEqual([]);
  });
});
