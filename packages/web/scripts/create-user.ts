import "./env.js";
import { parseArgs } from "node:util";
import { openDb } from "../src/db/index.js";
import { createUser } from "../src/store.js";
import { signSessionToken } from "../src/tokens.js";

// npm run user:create -- --name "Matthew" --email you@example.com
const { values } = parseArgs({ options: { name: { type: "string" }, email: { type: "string" } } });
if (!values.name) {
  console.error('Usage: npm run user:create -- --name "Name" [--email you@example.com]');
  process.exit(1);
}
const db = await openDb({ databaseUrl: process.env.DATABASE_URL || undefined, pgliteDir: process.env.PGLITE_DIR });
const secret = process.env.TOKEN_SECRET;
if (!secret) {
  console.error("TOKEN_SECRET is required (it signs the session token this prints)");
  process.exit(1);
}
const { user } = await createUser(db, { name: values.name, email: values.email });
const { token, expiresAt } = signSessionToken(user.id, secret);
console.log(JSON.stringify({ user, token, expires_at: expiresAt }, null, 2));
await db.close();
