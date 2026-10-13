import "./env.js";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { context } from "esbuild";
import { Hono } from "hono";
import { getDb, migrate } from "../src/db/index.js";
import { clientBuild } from "./client.js";

if (!process.env.TOKEN_SECRET) {
  process.env.TOKEN_SECRET = randomBytes(32).toString("hex");
  console.warn("TOKEN_SECRET is unset: using a random one, so sessions end when this server restarts.");
}
const { default: app } = await import("../src/index.js"); // after TOKEN_SECRET is settled

// Open and migrate up front so the first request isn't slow and a fresh local database has its tables.
await migrate(await getDb());

// Rebuild the web UI bundle into public/ on change, and serve public/ the way Vercel's CDN serves the icons in
// production.
await (await context(clientBuild)).watch();
const local = new Hono();
local.use("*", serveStatic({ root: "./public" }));
local.route("/", app);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: local.fetch, port }, () => {
  const url = new URL((process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL)!);
  console.log(`loopway listening on http://localhost:${port} — db: Postgres (${url.host})`);
});
