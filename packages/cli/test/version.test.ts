import { describe, expect, it } from "vitest";
import { LoopwayClient } from "../src/client.js";
import { CLI_VERSION, VERSION_HEADER } from "../src/version.js";
import pkg from "../package.json" with { type: "json" };

describe("CLI version", () => {
  it("is the package version", () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it("is sent on every API request", async () => {
    let seen: Headers | undefined;
    const fetch = (async (_url: string, init: RequestInit) => {
      seen = new Headers(init.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await new LoopwayClient({ baseUrl: "https://loopway.test", fetch }).me();
    expect(seen?.get(VERSION_HEADER)).toBe(CLI_VERSION);
  });
});
