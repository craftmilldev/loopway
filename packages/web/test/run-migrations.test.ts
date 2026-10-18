import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { migrationUrl, runMigrations } from "../src/db/run-migrations.js";
import { DEFAULT_TEST_DATABASE_URL } from "../src/db/testing.js";
import { migrations } from "../src/db/migrations.js";
import type { Metrics } from "../src/metrics.js";

const admin = new URL(process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL);
const dbName = `run_migrations_${process.pid}`;
const urlFor = (name: string) => {
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return u.toString();
};

const events: { event: string; properties?: Record<string, unknown> }[] = [];
const metrics: Metrics = { capture: async (event, _id, properties) => void events.push({ event, properties }) };
const lines: string[] = [];
const log = (l: string) => void lines.push(l);

beforeAll(async () => {
  const root = await openDb({ databaseUrl: admin.toString() });
  await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.close();
  return async () => {
    const r = await openDb({ databaseUrl: admin.toString() });
    await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await r.close();
  };
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
});

describe("runMigrations", () => {
  it("applies pending migrations, then is a no-op", async () => {
    const env = { DATABASE_URL: urlFor(dbName) };
    const first = await runMigrations({ env, metrics, log });
    expect(first).toEqual(migrations.map((m) => m.version));
    expect(events).toEqual([{ event: "migrations_applied", properties: { count: migrations.length } }]);

    events.length = 0;
    expect(await runMigrations({ env, metrics, log })).toEqual([]);
    expect(events).toEqual([{ event: "migrations_applied", properties: { count: 0 } }]);
    expect(lines.at(-1)).toBe("Migrations up to date.");
  });

  it("migrates the unpooled URL when DATABASE_URL is the pooled one (Neon's names)", async () => {
    const env = { DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", DATABASE_URL_UNPOOLED: urlFor(dbName) };
    expect(await runMigrations({ env, metrics, log })).toEqual([]);
  });

  it("records migrations_failed and rethrows when the database can't be migrated", async () => {
    const env = { DATABASE_URL_UNPOOLED: "postgres://nobody@127.0.0.1:1/none" };
    await expect(runMigrations({ env, metrics, log })).rejects.toThrow();
    expect(events.map((e) => e.event)).toEqual(["migrations_failed"]);
  });

  it("records migrations_failed when a migration's SQL fails", async () => {
    const env = { DATABASE_URL: urlFor(dbName) };
    migrations.push({ version: "999_broken", sql: "SELECT * FROM loopway.no_such_table" });
    try {
      await expect(runMigrations({ env, metrics, log })).rejects.toThrow();
    } finally {
      migrations.pop();
    }
    expect(events.map((e) => e.event)).toEqual(["migrations_failed"]);
  });

  it("skips when no URL is set", async () => {
    expect(await runMigrations({ env: {}, metrics, log })).toBeNull();
    expect(events).toEqual([]);
  });
});
