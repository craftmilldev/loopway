import { createAnalytics, type BrowserAnalytics } from "@craftmilldev/analytics/browser";

// Product metrics for the web UI. The server puts its PostHog key in a <meta> tag (src/ui.ts); with no key this
// does nothing. Requests go through the shared proxy (the host meta tag).

let analytics: BrowserAnalytics | undefined;

export function startMetrics() {
  const key = document.querySelector<HTMLMetaElement>('meta[name="posthog-key"]')?.content;
  if (!key) return;
  analytics = createAnalytics({
    product: "loopway",
    app: "web",
    apiKey: key,
    host: document.querySelector<HTMLMetaElement>('meta[name="posthog-host"]')?.content || undefined,
    uiHost: document.querySelector<HTMLMetaElement>('meta[name="posthog-ui-host"]')?.content || undefined,
  });
}

/** Ties this browser to the user the server's events (webhooks, API errors) are recorded under. */
export function identify(id: string, props: { email: string | null; name: string }) {
  analytics?.identify(id, props);
}

/** Forgets the user, so the next person on this browser isn't recorded as them. */
export function reset() {
  analytics?.reset();
}

/** Records something the user did in the browser that the server never sees (a form that stopped before a request). */
export function track(event: string, props?: Record<string, string | number | boolean>) {
  analytics?.capture(event, props);
}
