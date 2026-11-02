import { createAnalytics } from "@craftmilldev/analytics/server";

/** Product metrics. Sends nothing unless POSTHOG_API_KEY is set. */
export interface Metrics {
  /** Records one event for `distinctId`. Never throws: metrics must not break a request. */
  capture(event: string, distinctId: string, properties?: Record<string, unknown>): Promise<void>;
}

export const noopMetrics: Metrics = { capture: async () => {} };

/** Who an event is about when nobody is logged in (a login attempt, an unknown inbox). */
export const ANONYMOUS = "anonymous";

/** Craftmill's shared PostHog proxy: where the server, the browser and the CLI send events unless told otherwise. */
export const POSTHOG_PROXY = "https://a.craftmill.dev/api/ingest";

/** POSTHOG_HOST when set (self-hosted PostHog, or another proxy), else the shared proxy. */
export function posthogHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.POSTHOG_HOST || POSTHOG_PROXY;
}

/** The browser reports to PostHog's EU UI when POSTHOG_HOST is an EU host (eu.i.posthog.com), else the US one. */
export function posthogUiHost(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return new URL(env.POSTHOG_HOST ?? "").hostname.startsWith("eu.")
      ? "https://eu.posthog.com"
      : "https://us.posthog.com";
  } catch {
    return "https://us.posthog.com";
  }
}

export function createMetrics(env: NodeJS.ProcessEnv = process.env): Metrics {
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return noopMetrics;
  // Sent right away, not batched: a serverless function can be frozen before a batch goes out.
  return createAnalytics({ product: "loopway", app: "web", apiKey, host: posthogHost(env) });
}
