import "./env.js";
import { migrate, openDb } from "../src/db/index.js";

// PGlite migrates on open; this is mainly for Supabase: DATABASE_URL=... npm run db:migrate
// Use the *session* pooler (5432) or direct connection for migrations if the transaction pooler complains.
const db = await openDb({ databaseUrl: process.env.DATABASE_URL || undefined, pgliteDir: process.env.PGLITE_DIR });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date.");
await db.close();
