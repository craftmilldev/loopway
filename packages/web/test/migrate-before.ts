import type { Db } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";

/**
 * Empties a migrated test database and applies only the migrations before `version`, so a test can fill it as it
 * was then and run `migrate()` for the rest.
 */
export async function migrateBefore(db: Db, version: string) {
  await db.query(`DROP SCHEMA loopway CASCADE`);
  await db.query(`CREATE SCHEMA loopway`);
  await db.query(
    `CREATE TABLE loopway.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  for (const m of migrations) {
    if (m.version === version) return;
    await db.transaction(async (tx) => {
      for (const stmt of m.sql
        .split(/;\s*$/m)
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.query(stmt);
      await tx.query(`INSERT INTO loopway.schema_migrations (version) VALUES ($1)`, [m.version]);
    });
  }
}
