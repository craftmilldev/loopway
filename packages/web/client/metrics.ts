import { posthog } from "posthog-js";

// Product metrics for the web UI. The server puts its PostHog key in a <meta> tag (src/ui.ts); with no key this
// does nothing. Requests go through Craftmill's shared proxy (the host meta tag, src/metrics.ts's POSTHOG_PROXY).

let on = false;

// Every browser event carries the product and the part of it that sent it, like the server's (src/metrics.ts).
const register = () => posthog.register({ product: "loopway", app: "web" });

export function startMetrics() {
  const key = document.querySelector<HTMLMetaElement>('meta[name="posthog-key"]')?.content;
  if (!key) return;
  posthog.init(key, {
    api_host: document.querySelector<HTMLMetaElement>('meta[name="posthog-host"]')?.content || undefined,
    ui_host: document.querySelector<HTMLMetaElement>('meta[name="posthog-ui-host"]')?.content || undefined,
    person_profiles: "identified_only",
    defaults: "2025-05-24",
  });
  register();
  on = true;
}

/** Records something the user did in the browser that the server never sees (a link followed). */
export function track(event: string, props?: Record<string, string | number | boolean>) {
  if (on) posthog.capture(event, props);
}
