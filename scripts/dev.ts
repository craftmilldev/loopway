import "./env.js";
import { serve } from "@hono/node-server";
import app from "../src/index.js";
import { getDb } from "../src/db/index.js";

await getDb(); // open + migrate PGlite up front so the first request isn't slow
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  const where = process.env.DATABASE_URL ? "Postgres (DATABASE_URL)" : `PGlite (${process.env.PGLITE_DIR ?? "./.data/pglite"})`;
  console.log(`loopway listening on http://localhost:${port} — db: ${where}`);
});
