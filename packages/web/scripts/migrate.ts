import { migrate, openDb } from "../src/db/index.js";
import { migrationUrl } from "../src/db/run-migrations.js";
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

// `npm run dev` migrates the local database itself; this is for the hosted one: DATABASE_URL=... npm run db:migrate
// Use a session-mode URL (Supabase's POSTGRES_URL_NON_POOLING, port 5432), not the transaction pooler on 6543.
const databaseUrl = migrationUrl();
if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
const db = await openDb({ databaseUrl });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date.");
const moved = await encryptInboxSecrets(db, secretBox(process.env.INBOX_SECRET_KEY)); // throws if it is unset
if (moved) console.log(`Encrypted ${moved} inbox secrets.`);
await db.close();
