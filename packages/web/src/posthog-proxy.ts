import { Hono } from "hono";

/** Where PostHog events and assets are served from, per region (https://posthog.com/docs/advanced/proxy). */
const HOSTS = {
  us: { api: "us.i.posthog.com", assets: "us-assets.i.posthog.com" },
  eu: { api: "eu.i.posthog.com", assets: "eu-assets.i.posthog.com" },
};

export interface PosthogProxyOptions {
  /** Which PostHog cloud region to forward to. Defaults to "us". */
  region?: keyof typeof HOSTS;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** A reverse proxy for PostHog under /ingest, so analytics requests come from our own domain (ad blockers skip them). */
export function createPosthogProxy(opts: PosthogProxyOptions = {}) {
  const hosts = HOSTS[opts.region ?? "us"];
  const doFetch = opts.fetch ?? fetch;
  const app = new Hono();

  app.all("/ingest/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname.slice("/ingest".length);
    const host = path.startsWith("/static/") || path.startsWith("/array/") ? hosts.assets : hosts.api;

    const headers = new Headers(c.req.raw.headers);
    headers.set("host", host);
    // Let PostHog see the real client for geo/IP, and don't leak our cookies or auth to it.
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    headers.delete("cookie");
    headers.delete("authorization");
    headers.delete("x-forwarded-for");
    if (ip) headers.set("x-forwarded-for", ip);
    // Fetch decodes the response, so don't ask for an encoding we would have to pass through.
    headers.delete("accept-encoding");

    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    const res = await doFetch(`https://${host}${path}${url.search}`, {
      method: c.req.method,
      headers,
      body: hasBody ? await c.req.arrayBuffer() : undefined,
      redirect: "manual",
    });

    const out = new Headers(res.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    out.delete("transfer-encoding");
    return new Response(res.body, { status: res.status, headers: out });
  });

  return app;
}
