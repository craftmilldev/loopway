import { migrate, openDb } from "../src/db/index.js";
import { secretBox } from "../src/secrets.js";
import { encryptInboxSecrets } from "../src/store.js";

// Prod config lives in .env.production (gitignored). It's loaded first so it wins over the
// dev .env, and a local DATABASE_URL never gets migrated by mistake.
for (const f of [".env.production", ".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* missing file is fine */
  }
}

// `npm run dev` migrates the local database itself; this is for Neon: DATABASE_URL=... npm run db:migrate
// Use Neon's *direct* connection string (no `-pooler` in the host) for migrations.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
const db = await openDb({ databaseUrl: process.env.DATABASE_URL });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date.");
const moved = await encryptInboxSecrets(
  db,
  process.env.INBOX_SECRET_KEY ? secretBox(process.env.INBOX_SECRET_KEY) : undefined,
);
if (moved) console.log(`Encrypted ${moved} inbox secrets.`);
await db.close();
