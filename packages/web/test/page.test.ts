import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the marketing page", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  it("is one static file with a title", () => {
    expect(html).toContain("<title>loopway</title>");
  });

  it("sends only a page load and GitHub clicks, through the shared proxy", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script src="https://a.craftmill.dev/api/ingest/static/array.js">', "<script>"]);
    expect(html).toContain('api_host: "https://a.craftmill.dev/api/ingest"');
    expect(html).toContain('"github_clicked"');
    expect(html).toContain('transport: "sendBeacon"');
    expect(html).toContain("autocapture: false");
  });

  it("shows the billboard, with a way to see it full screen that works without scripts", () => {
    expect(html).toContain('<iframe\n        src="billboard/"');
    expect(html).toContain('<a class="full" href="billboard/" aria-label="Full screen" title="Full screen">');
    expect(html).toContain("requestFullscreen()");
    const billboard = readFileSync(new URL("../public/billboard/index.html", import.meta.url), "utf8");
    expect(billboard).toContain("<title>Loopway billboard</title>");
    expect(billboard).not.toMatch(/<script\b[^>]*\bsrc=/);
  });

  it("gives the install commands a copy button", () => {
    expect(html).toContain("git clone https://github.com/craftmilldev/loopway.git");
    expect(html).toContain('<button type="button">Copy</button>');
    expect(html).toContain("navigator.clipboard.writeText(text)");
  });

  it("is what vercel.json serves, with no build step", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config.outputDirectory).toBe("public");
    expect(config.buildCommand).toBeNull();
    expect(config.crons).toBeUndefined();
  });
});
