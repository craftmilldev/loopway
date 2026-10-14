import { createHash } from "node:crypto";
import { migrations } from "./migrations.js";

/**
 * The only thing the rest of the app knows about the database.
 * Postgres everywhere: a local Docker Postgres (see docker-compose.yml) in dev and tests, Neon on Vercel.
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

export async function openDb(opts: DbOptions): Promise<Db> {
  const { default: postgres } = await import("postgres");
  // Neon's connection strings carry libpq's `channel_binding`, which postgres.js doesn't understand
  // and would forward to the server as a startup parameter.
  const u = new URL(opts.databaseUrl);
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

// Arbitrary constant key for the migration advisory lock.
const MIGRATE_LOCK = 71_000_001;

export interface MigrateOptions {
  /** Drops the whole `loopway` schema (every table and row) before migrating. For throwaway databases only. */
  reset?: boolean;
}

export async function migrate(db: Db, opts: MigrateOptions = {}): Promise<string[]> {
  // One transaction (Postgres DDL is transactional), so a failure leaves nothing half-applied and unrecorded.
  // The transaction-scoped advisory lock goes first, so builds that start together against one database
  // queue up: the second one waits, then finds nothing left to apply.
  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATE_LOCK]);
    if (opts.reset) await tx.query(`DROP SCHEMA IF EXISTS loopway CASCADE`);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS loopway`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS loopway.schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await tx.query(`ALTER TABLE loopway.schema_migrations ADD COLUMN IF NOT EXISTS checksum text`);
    const done = new Map(
      (
        await tx.query<{ version: string; checksum: string | null }>(
          `SELECT version, checksum FROM loopway.schema_migrations`,
        )
      ).map((r) => [r.version, r.checksum]),
    );
    const applied: string[] = [];
    for (const m of migrations) {
      const checksum = createHash("sha256").update(m.sql).digest("hex");
      if (done.has(m.version)) {
        const recorded = done.get(m.version);
        if (recorded == null) {
          // Applied before checksums existed: trust the current SQL and record it from here on.
          await tx.query(`UPDATE loopway.schema_migrations SET checksum = $1 WHERE version = $2`, [
            checksum,
            m.version,
          ]);
        } else if (recorded !== checksum) {
          throw new Error(
            `Migration ${m.version} was edited after it was applied to this database. ` +
              `Undo the edit and add a new migration instead, or reset this database if it is a throwaway one (a local dev database or a preview branch).`,
          );
        }
        continue;
      }
      // Each statement separately: postgres.js unsafe() with params can't run multi-statement strings.
      for (const stmt of splitSql(m.sql)) await tx.query(stmt);
      await tx.query(`INSERT INTO loopway.schema_migrations (version, checksum) VALUES ($1, $2)`, [
        m.version,
        checksum,
      ]);
      applied.push(m.version);
    }
    return applied;
  });
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
    const databaseUrl = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is not set. Locally: `npm run db:up`, then copy packages/web/.env.example to .env.",
      );
    }
    shared = openDb({ databaseUrl });
  }
  return shared;
}
