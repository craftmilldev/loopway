import { migrate, openDb } from "./index.js";
import { secretBox } from "../secrets.js";
import { encryptInboxSecrets } from "../store.js";
import { ANONYMOUS, type Metrics } from "../metrics.js";

/**
 * The URL migrations run against: `DATABASE_URL_UNPOOLED`, else `DATABASE_URL`, else `POSTGRES_URL_NON_POOLING`
 * (the session-mode URL Vercel's Supabase integration sets). Never a transaction-mode pooled URL
 * (`DATABASE_URL_POOLED`, `POSTGRES_URL`): it isn't safe for DDL.
 */
export function migrationUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || env.POSTGRES_URL_NON_POOLING || undefined;
}

export interface RunMigrationsOptions {
  env?: NodeJS.ProcessEnv;
  metrics: Metrics;
  log?: (line: string) => void;
}

/**
 * Applies pending migrations (the Vercel build runs this before bundling). Records `migrations_applied` (with how many
 * ran, none included) or `migrations_failed`, then rethrows so a failure fails the build. Returns the applied
 * versions, or null when no database URL is set and there was nothing to migrate.
 */
export async function runMigrations(opts: RunMigrationsOptions): Promise<string[] | null> {
  const log = opts.log ?? console.log;
  const databaseUrl = migrationUrl(opts.env);
  if (!databaseUrl) {
    log("No DATABASE_URL_UNPOOLED, DATABASE_URL or POSTGRES_URL_NON_POOLING set; skipping migrations.");
    return null;
  }
  const key = (opts.env ?? process.env).INBOX_SECRET_KEY;
  let applied: string[];
  let moved: number | null;
  try {
    const db = await openDb({ databaseUrl });
    try {
      applied = await migrate(db);
      moved = await encryptInboxSecrets(db, secretBox(key));
    } finally {
      await db.close();
    }
  } catch (err) {
    await opts.metrics.capture("migrations_failed", ANONYMOUS, {
      reason: err instanceof Error ? err.name : "unknown",
    });
    throw err;
  }
  await opts.metrics.capture("migrations_applied", ANONYMOUS, { count: applied.length });
  if (moved) await opts.metrics.capture("inbox_secrets_encrypted", ANONYMOUS, { count: moved });
  log(applied.length ? `Applied: ${applied.join(", ")}` : "Migrations up to date.");
  if (moved) log(`Encrypted ${moved} inbox secrets.`);
  return applied;
}
