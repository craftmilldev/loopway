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
    // Each statement separately: postgres.js unsafe() with params can't run multi-statement strings.
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
