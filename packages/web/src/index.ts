// Vercel entry point. Vercel detects Hono at src/index.ts and serves the default export as a Function.
import { Hono } from "hono";
import { createApi } from "./api.js";
import { getDb } from "./db/index.js";
import { consoleSender, resendSender } from "./email.js";

const app = new Hono();

const tokenSecret = process.env.TOKEN_SECRET;
if (!tokenSecret) throw new Error("TOKEN_SECRET is required (it signs session tokens)");

app.route(
  "/",
  createApi({
    getDb,
    tokenSecret,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
    sendEmail: process.env.RESEND_API_KEY
      ? resendSender({
          apiKey: process.env.RESEND_API_KEY,
          from: "loopway <matthew@craftmill.dev>",
        })
      : consoleSender,
  }),
);

export default app;
