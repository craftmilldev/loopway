import "./env.js";
import { parseArgs } from "node:util";
import { openDb } from "../src/db/index.js";
import { createUser } from "../src/store.js";

// npm run user:create -- --name "Matthew" --email you@example.com
const { values } = parseArgs({ options: { name: { type: "string" }, email: { type: "string" } } });
if (!values.name) {
  console.error('Usage: npm run user:create -- --name "Name" [--email you@example.com]');
  process.exit(1);
}
const db = await openDb({ databaseUrl: process.env.DATABASE_URL || undefined, pgliteDir: process.env.PGLITE_DIR });
const { user, apiKey } = await createUser(db, { name: values.name, email: values.email });
console.log(JSON.stringify({ user, api_key: apiKey }, null, 2));
console.log("\nSave the api_key now — only its hash is stored.");
await db.close();
