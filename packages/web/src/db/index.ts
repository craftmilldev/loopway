import { migrations } from "./migrations.js";

/**
 * The only thing the rest of the app knows about the database.
 * Postgres everywhere: a local Docker Postgres (see docker-compose.yml) in dev and tests, Supabase on Vercel.
 * For jsonb params, pass the JS object itself (not JSON.stringify'd): postgres.js learns the param
 * type from the server and serializes it, so a pre-stringified value gets stored as a JSON *string*.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn on one connection inside BEGIN/COMMIT; rolls back if it throws. */
  transaction<R>(fn: (tx: Pick<Db, "query">) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** postgres:// URL. */
  databaseUrl: string;
}

/**
 * Query params in hosted Postgres URLs that aren't connection settings postgres.js knows: it would send them to the
 * server as startup parameters, which then refuses the connection. Vercel's Supabase integration adds `supa` and
 * `pgbouncer`; libpq-style strings (Neon's, among others) carry `channel_binding`.
 */
const FOREIGN_PARAMS = ["supa", "pgbouncer", "channel_binding"];

/** The URL as postgres.js should see it: trimmed, unquoted, without FOREIGN_PARAMS. `sslmode` stays. */
export function connectionUrl(url: string): string {
  const u = new URL(url.trim().replace(/^(['"])(.*)\1$/, "$2"));
  for (const p of FOREIGN_PARAMS) u.searchParams.delete(p);
  return u.toString();
}

export async function openDb(opts: DbOptions): Promise<Db> {
  const { default: postgres } = await import("postgres");
  // prepare:false: Supabase's pooler (Supavisor, port 6543) runs in transaction mode, as do other poolers.
  // onnotice: no-op, since postgres.js console.logs NOTICEs by default, and our idempotent
  // `CREATE ... IF NOT EXISTS` migration bookkeeping emits one on every run.
  const sql = postgres(connectionUrl(opts.databaseUrl), { prepare: false, max: 5, idle_timeout: 20, onnotice: () => {} });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
    async transaction<R>(fn: (tx: Pick<Db, "query">) => Promise<R>) {
      return (await sql.begin((tx) =>
        fn({
          query: async <T>(text: string, params: unknown[] = []) =>
            (await tx.unsafe(text, params as never[])) as unknown as T[],
        }),
      )) as R;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Arbitrary constant: the advisory lock that makes concurrent `migrate()` runs (two builds at once) take turns. */
export const MIGRATE_LOCK = 7_204_113;

export async function migrate(db: Db): Promise<string[]> {
  // Transaction-level locks (not session-level) so this holds through a pooler and releases itself on failure.
  await db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATE_LOCK]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS loopway`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS loopway.schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  });
  const applied: string[] = [];
  for (const m of migrations) {
    // Each statement separately: postgres.js unsafe() with params can't run multi-statement strings.
    // One transaction (Postgres DDL is transactional), so a failure leaves nothing half-applied and unrecorded.
    // Under the lock, re-check: a concurrent run may have applied it since we started.
    const ran = await db.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATE_LOCK]);
      const done = await tx.query(`SELECT 1 FROM loopway.schema_migrations WHERE version = $1`, [m.version]);
      if (done.length) return false;
      for (const stmt of splitSql(m.sql)) await tx.query(stmt);
      await tx.query(`INSERT INTO loopway.schema_migrations (version) VALUES ($1)`, [m.version]);
      return true;
    });
    if (ran) applied.push(m.version);
  }
  return applied;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The URL the server queries through. See getDb. */
export function serverUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DATABASE_URL_POOLED || env.DATABASE_URL || env.POSTGRES_URL || undefined;
}

let shared: Promise<Db> | undefined;

/**
 * Process-wide DB, configured from env. Reused across requests (and across invocations on warm Vercel functions).
 * Serves from DATABASE_URL_POOLED, else DATABASE_URL, else POSTGRES_URL (the pooled URL Vercel's Supabase
 * integration sets). Migrations pick their own URL in run-migrations.ts.
 */
export function getDb(): Promise<Db> {
  if (!shared) {
    const databaseUrl = serverUrl();
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is not set. Locally: `npm run db:up`, then copy packages/web/.env.example to .env.",
      );
    }
    shared = openDb({ databaseUrl });
  }
  return shared;
}
