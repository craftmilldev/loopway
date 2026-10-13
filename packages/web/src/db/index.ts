import { migrations } from "./migrations.js";

/**
 * The only thing the rest of the app knows about the database.
 * Both drivers speak Postgres, so the SQL is identical locally (PGlite) and on Vercel (Neon).
 */
/**
 * For jsonb params, pass the JS object itself (not JSON.stringify'd): both drivers learn the param
 * type from the server and serialize it — a pre-stringified value gets stored as a JSON *string*.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /**
   * Runs `fn` in one transaction on one connection: commits when it resolves, rolls back when it throws.
   * Use the `query` it is given, not the outer `db.query` (which may land on another connection).
   */
  transaction<R>(fn: (tx: Pick<Db, "query">) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** postgres:// URL. When absent, PGlite is used. */
  databaseUrl?: string;
  /** PGlite data dir, or "memory://". */
  pgliteDir?: string;
}

export async function openDb(opts: DbOptions = {}): Promise<Db> {
  if (opts.databaseUrl) return openPostgres(opts.databaseUrl);
  return openPglite(opts.pgliteDir ?? "./.data/pglite");
}

async function openPostgres(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  // Neon's connection strings carry libpq's `channel_binding`, which postgres.js doesn't understand
  // and would forward to the server as a startup parameter.
  const u = new URL(url);
  u.searchParams.delete("channel_binding");
  // prepare:false: Neon's pooled endpoint (-pooler) is PgBouncer in transaction mode.
  // onnotice: no-op, since postgres.js console.logs NOTICEs by default, and our idempotent
  // `CREATE ... IF NOT EXISTS` migration bookkeeping emits one on every run.
  const sql = postgres(u.toString(), { prepare: false, max: 5, idle_timeout: 20, onnotice: () => {} });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
    async transaction<R>(fn: (tx: Pick<Db, "query">) => Promise<R>) {
      return (await sql.begin(async (tx) =>
        fn({
          async query<T>(text: string, params: unknown[] = []) {
            return (await tx.unsafe(text, params as never[])) as unknown as T[];
          },
        }),
      )) as R;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

async function openPglite(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dir !== "memory://") {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
  }
  const pg = new PGlite(dir);
  await pg.waitReady;
  const db: Db = {
    async query<T>(text: string, params: unknown[] = []) {
      const res = await pg.query<T>(text, params);
      return res.rows;
    },
    async transaction<R>(fn: (tx: Pick<Db, "query">) => Promise<R>) {
      return pg.transaction(async (tx) =>
        fn({
          async query<T>(text: string, params: unknown[] = []) {
            return (await tx.query<T>(text, params)).rows;
          },
        }),
      );
    },
    async close() {
      await pg.close();
    },
  };
  // Local DBs migrate themselves; Neon is migrated explicitly with `npm run db:migrate`.
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE SCHEMA IF NOT EXISTS loopway`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS loopway.schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await db.query<{ version: string }>(`SELECT version FROM loopway.schema_migrations`)).map((r) => r.version),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    // Each statement separately: postgres.js unsafe() with params can't run multi-statement strings,
    // and PGlite's query() is single-statement too.
    for (const stmt of splitSql(m.sql)) await db.query(stmt);
    await db.query(`INSERT INTO loopway.schema_migrations (version) VALUES ($1)`, [m.version]);
    applied.push(m.version);
  }
  return applied;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

let shared: Promise<Db> | undefined;

/**
 * Process-wide DB, configured from env. Reused across requests (and across invocations on warm Vercel functions).
 * Prefers Neon's pooled URL for serving; scripts (migrate) use the direct DATABASE_URL.
 */
export function getDb(): Promise<Db> {
  if (!shared) {
    const databaseUrl = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || undefined;
    if (!databaseUrl && process.env.VERCEL) {
      throw new Error("DATABASE_URL must be set on Vercel (PGlite has no persistent disk there).");
    }
    shared = openDb({ databaseUrl, pgliteDir: process.env.PGLITE_DIR });
  }
  return shared;
}
