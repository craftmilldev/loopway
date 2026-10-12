import { describe, expect, it } from "vitest";
import { createPosthogProxy } from "../src/posthog-proxy.js";

function setup(region?: "us" | "eu") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("ok", { status: 200, headers: { "content-encoding": "gzip", "x-ph": "1" } });
  }) as unknown as typeof fetch;
  return { calls, app: createPosthogProxy({ region, fetch: fakeFetch }) };
}

describe("posthog proxy", () => {
  it("forwards events to the api host with query and body", async () => {
    const { app, calls } = setup();
    const res = await app.request("/ingest/e/?ip=1", {
      method: "POST",
      body: "payload",
      headers: { cookie: "s=1", "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("x-ph")).toBe("1");
    expect(res.headers.has("content-encoding")).toBe(false);
    expect(calls[0]!.url).toBe("https://us.i.posthog.com/e/?ip=1");
    const headers = calls[0]!.init.headers as Headers;
    expect(headers.get("host")).toBe("us.i.posthog.com");
    expect(headers.get("x-forwarded-for")).toBe("1.2.3.4");
    expect(headers.has("cookie")).toBe(false);
  });

  it("sends static and array paths to the assets host", async () => {
    const { app, calls } = setup("eu");
    await app.request("/ingest/static/array.js");
    await app.request("/ingest/array/phc_x/config");
    expect(calls.map((c) => c.url)).toEqual([
      "https://eu-assets.i.posthog.com/static/array.js",
      "https://eu-assets.i.posthog.com/array/phc_x/config",
    ]);
  });
});
