// Vercel entry point. Vercel detects Hono at src/index.ts and serves the default export as a Function.
import { Hono } from "hono";
import { createApi, parseScheduleOptions } from "./api.js";
import { minCliVersion } from "./cli-version.js";
import { getDb } from "./db/index.js";
import { senderFromEnv } from "./email.js";
import { createMetrics, posthogHost, posthogUiHost } from "./metrics.js";

const app = new Hono();

const tokenSecret = process.env.TOKEN_SECRET;
if (!tokenSecret) throw new Error("TOKEN_SECRET is required (it signs session tokens)");

const inboxSecretKey = process.env.INBOX_SECRET_KEY;
if (!inboxSecretKey) throw new Error("INBOX_SECRET_KEY is required (it encrypts inbox webhook secrets)");

app.route(
  "/",
  createApi({
    getDb,
    tokenSecret,
    inboxSecretKey,
    cronSecret: process.env.CRON_SECRET || undefined,
    scheduleOptions: parseScheduleOptions(process.env.SCHEDULE_OPTIONS),
    metrics: createMetrics(),
    posthogKey: process.env.POSTHOG_API_KEY || undefined,
    posthogHost: posthogHost(),
    posthogUiHost: posthogUiHost(),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
    signupsClosed: /^closed$/i.test(process.env.SIGNUPS ?? ""),
    minCliVersion: minCliVersion(process.env.MIN_CLI_VERSION),
    sendEmail: senderFromEnv(),
  }),
);

export default app;
