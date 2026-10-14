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

// `npm run dev` migrates the local database itself; this is for Neon. Vercel runs it at build time
// (see vercel.json), and it can be run by hand: DATABASE_URL=... npm run db:migrate
// Use Neon's *direct* connection string (no `-pooler` in the host) for migrations.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");

// MIGRATE_RESET=drop-all-data wipes the database (the whole `loopway` schema) before migrating, so an
// environment with it set starts from nothing on every deploy. Set it on Vercel's Preview environment only,
// never on one that holds real data; it is refused on Vercel's production environment.
const reset = process.env.MIGRATE_RESET === "drop-all-data";
if (process.env.MIGRATE_RESET && !reset) {
  throw new Error(`MIGRATE_RESET must be "drop-all-data" or unset, got "${process.env.MIGRATE_RESET}".`);
}
if (reset && process.env.VERCEL_ENV === "production") {
  throw new Error("MIGRATE_RESET=drop-all-data is set on the production environment. Refusing to drop its data.");
}
if (reset) console.log("MIGRATE_RESET=drop-all-data: dropping the loopway schema before migrating.");

const db = await openDb({ databaseUrl: process.env.DATABASE_URL });
const applied = await migrate(db, { reset });
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date.");
await db.close();
