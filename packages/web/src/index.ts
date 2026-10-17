// Vercel entry point. Vercel detects Hono at src/index.ts and serves the default export as a Function.
import { Hono } from "hono";
import { createApi } from "./api.js";
import { getDb } from "./db/index.js";
import { consoleSender, resendSender } from "./email.js";
import { createMetrics } from "./metrics.js";

/** The /api/ingest proxy forwards to PostHog's EU cloud when POSTHOG_HOST is an EU host (eu.i.posthog.com), else US. */
function posthogRegion(host: string | undefined) {
  try {
    return host && new URL(host).hostname.startsWith("eu.") ? "eu" : "us";
  } catch {
    return "us";
  }
}

const app = new Hono();

const tokenSecret = process.env.TOKEN_SECRET;
if (!tokenSecret) throw new Error("TOKEN_SECRET is required (it signs session tokens)");

app.route(
  "/",
  createApi({
    getDb,
    tokenSecret,
    cronSecret: process.env.CRON_SECRET || undefined,
    metrics: createMetrics(),
    posthogKey: process.env.POSTHOG_API_KEY || undefined,
    posthogRegion: posthogRegion(process.env.POSTHOG_HOST),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
    selfHosted: ["1", "true"].includes(process.env.SELF_HOSTED ?? ""),
    minCliVersion: process.env.MIN_CLI_VERSION || undefined,
    enterpriseLicense: process.env.CRAFTMILL_ENTERPRISE_LICENSE || undefined,
    sourceRequests:
      process.env.SOURCE_REQUEST_URL && process.env.SOURCE_REQUEST_TOKEN
        ? { url: process.env.SOURCE_REQUEST_URL, token: process.env.SOURCE_REQUEST_TOKEN }
        : undefined,
    sendEmail: process.env.RESEND_API_KEY
      ? resendSender({
          apiKey: process.env.RESEND_API_KEY,
          from: "loopway <matthew@craftmill.dev>",
        })
      : consoleSender,
  }),
);

export default app;
