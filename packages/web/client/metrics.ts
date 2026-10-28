import { posthog } from "posthog-js";

// Product metrics for the web UI. The server puts its PostHog key in a <meta> tag (src/ui.ts); with no key this
// does nothing. Requests go through our own /api/ingest proxy (src/posthog-proxy.ts).

let on = false;

export function startMetrics() {
  const key = document.querySelector<HTMLMetaElement>('meta[name="posthog-key"]')?.content;
  if (!key) return;
  posthog.init(key, {
    api_host: "/api/ingest",
    ui_host: document.querySelector<HTMLMetaElement>('meta[name="posthog-ui-host"]')?.content || undefined,
    person_profiles: "identified_only",
    defaults: "2025-05-24",
  });
  // Every browser event carries the product, like the server's (src/metrics.ts), so reports can filter by it.
  posthog.register({ product: "loopway", app: "browser" });
  on = true;
}

/** Ties this browser to the user the server's events (webhooks, API errors) are recorded under. */
export function identify(id: string, props: { email: string | null; name: string }) {
  if (on) posthog.identify(id, props);
}

/** Forgets the user, so the next person on this browser isn't recorded as them. */
export function reset() {
  if (on) posthog.reset();
}

/** Records something the user did in the browser that the server never sees (a form that stopped before a request). */
export function track(event: string, props?: Record<string, string | number | boolean>) {
  if (on) posthog.capture(event, props);
}
