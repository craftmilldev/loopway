import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the marketing page", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  it("is one static file with a title", () => {
    expect(html).toContain("<title>loopway</title>");
  });

  it("sends only the events the funnel needs, through the shared proxy", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script src="https://a.craftmill.dev/api/ingest/static/array.js">', "<script>"]);
    expect(html).toContain('api_host: "https://a.craftmill.dev/api/ingest"');
    expect(html).toContain("autocapture: false");
    for (const name of ['"frame_viewed"', '"install_copied"', '"github_clicked"', "`${first}_found`"]) {
      expect(html).toContain(name);
    }
    expect(html).toContain('transport: "sendBeacon"');
  });

  it("is the billboard full screen, with a card for each frame after the sign", () => {
    expect(html).toContain('class="billboard"');
    expect(html).toContain('src="billboard/"');
    for (const frame of ["description", "install", "get-started", "github"]) {
      expect(html).toContain(`data-frame="${frame}"`);
    }
    expect(html).toContain('const names = ["tagline", "description", "install", "get-started", "github"]');
    expect(html).toContain("scroll &darr;");
    // The tracker is on the last card only.
    expect(html.match(/class="tracker"/g)).toHaveLength(1);
    expect(html.indexOf('class="tracker"')).toBeGreaterThan(html.indexOf('data-frame="github"'));
    const billboard = readFileSync(new URL("../public/billboard/index.html", import.meta.url), "utf8");
    expect(billboard).toContain("<title>Loopway billboard</title>");
    expect(billboard).toContain("Keep your agents and team in same loop");
    expect(billboard).not.toMatch(/<script\b[^>]*\bsrc=/);
  });

  it("puts the install host in one place, with a copy button", () => {
    expect(html.match(/loopway\.craftmill\.dev/g)).toHaveLength(1);
    expect(html).toContain("/install.sh | sh");
    expect(html).toContain('<button type="button">Copy</button>');
    expect(html).toContain("navigator.clipboard.writeText(");
  });

  it("links GitHub in a new tab and the bot docs to a page that does not exist yet", () => {
    expect(html).toContain('href="https://github.com/craftmilldev/loopway" target="_blank"');
    expect(html).toContain('href="/bots"');
  });

  it("only tells the page about a first find, and keeps the finds in localStorage", () => {
    const billboard = readFileSync(new URL("../public/billboard/index.html", import.meta.url), "utf8");
    expect(billboard).toContain('const KEPT = "loopway.found"');
    expect(billboard).toContain("if (!kept()[what]) keep({ [what]: true }, what)");
    expect(billboard).toContain('parent.postMessage({ loopway: "billboard"');
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
