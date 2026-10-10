import { migrate, openDb } from "../src/db/index.js";

// Prod config lives in .env.production (gitignored). It's loaded first so it wins over the
// dev .env, and a local DATABASE_URL never gets migrated by mistake.
for (const f of [".env.production", ".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* missing file is fine */
  }
}

// PGlite migrates on open; this is mainly for Neon: DATABASE_URL=... npm run db:migrate
// Use Neon's *direct* connection string (no `-pooler` in the host) for migrations.
const db = await openDb({ databaseUrl: process.env.DATABASE_URL || undefined, pgliteDir: process.env.PGLITE_DIR });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date.");
await db.close();
