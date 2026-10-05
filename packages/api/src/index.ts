// Vercel entry point. Vercel detects Hono at src/index.ts and serves the default export as a Function.
import { Hono } from "hono";
import { createApi } from "./api.js";
import { getDb } from "./db/index.js";

const app = new Hono();

app.route(
  "/",
  createApi({
    getDb,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
  }),
);

export default app;
