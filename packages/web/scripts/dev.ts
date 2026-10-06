import "./env.js";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { context } from "esbuild";
import { Hono } from "hono";
import { getDb } from "../src/db/index.js";
import { clientBuild } from "./client.js";

if (!process.env.TOKEN_SECRET) {
  process.env.TOKEN_SECRET = randomBytes(32).toString("hex");
  console.warn("TOKEN_SECRET is unset: using a random one, so sessions end when this server restarts.");
}
const { default: app } = await import("../src/index.js"); // after TOKEN_SECRET is settled

await getDb(); // open + migrate PGlite up front so the first request isn't slow

// Rebuild the web UI bundle into public/ on change, and serve public/ the way Vercel's CDN does in production.
await (await context(clientBuild)).watch();
const local = new Hono();
local.use("*", serveStatic({ root: "./public" }));
local.route("/", app);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: local.fetch, port }, () => {
  const remote = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
  const where = remote ? `Postgres (${new URL(remote).host})` : `PGlite (${process.env.PGLITE_DIR ?? "./.data/pglite"})`;
  console.log(`loopway listening on http://localhost:${port} — db: ${where}`);
});
