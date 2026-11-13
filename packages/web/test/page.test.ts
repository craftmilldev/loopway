import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the marketing page", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  it("is one static file with a title", () => {
    expect(html).toContain("<title>loopway</title>");
  });

  it("is the billboard itself: one canvas, no iframe, and no other file to load", () => {
    expect(html).toContain('<canvas id="scene"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("fetch(");
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual([
      '<script src="https://a.craftmill.dev/api/ingest/static/array.js">',
      "<script>",
      '<script type="image/svg+xml" id="wordmark-svg">',
      "<script>",
    ]);
  });

  it("carries the wordmark in the page, the same as wordmark.svg", () => {
    const file = readFileSync(new URL("../public/wordmark.svg", import.meta.url), "utf8");
    const inline = html.match(/<script type="image\/svg\+xml" id="wordmark-svg">([\s\S]*?)<\/script>/)?.[1];
    // The formatter re-indents the copy, so the two are compared without their white space.
    const bare = (text: string | undefined) => text?.replace(/\s+/g, "");
    expect(bare(inline)).toBe(bare(file));
  });

  it("sends only the events the funnel needs, through the shared proxy", () => {
    expect(html).toContain('api_host: "https://a.craftmill.dev/api/ingest"');
    expect(html).toContain("autocapture: false");
    for (const name of ['"frame_viewed"', '"install_copied"', '"github_clicked"', "`${what}_found`"]) {
      expect(html).toContain(name);
    }
    expect(html).toContain('transport: "sendBeacon"');
  });

  it("has a frame for each of the five things the sign says, painted on the sign", () => {
    expect(html).toContain('const FRAMES = ["tagline", "description", "install", "get-started", "github"]');
    // The hint is painted at the bottom middle of the sign, with a real button behind it for the keyboard.
    expect(html).toContain('ctx.fillText("SCROLL \\u2193", 0, 0)');
    expect(html).toContain('kind: "scroll"');
    // It wiggles, so it is drawn live over the still face rather than painted into it.
    expect(html).toContain("function drawScrollHint(ctx, cx, baseline, fade)");
    expect(html).toContain("scroll &darr;");
    expect(html).toContain("Keep your agents and team in the same loop");
    // The content is drawn on the board's face, not laid over the page.
    expect(html).toContain("function drawFaceContent(ctx, w, h)");
    expect(html).toContain("} else drawFaceContent(ctx, w, h);");
    expect(html).not.toContain('class="card"');
  });

  it("puts the install host in one place, with a copy button painted on the sign", () => {
    expect(html.match(/loopway\.craftmill\.dev/g)).toHaveLength(1);
    expect(html).toContain("/install.sh | sh");
    expect(html).toContain('hit("copy"');
    expect(html).toContain("navigator.clipboard.writeText(text)");
    // Only a copy that happened is counted, and the links and Copy answer to the click, not the press.
    expect(html).toContain("else if (await copy(INSTALL))");
    expect(html).toContain('canvas.addEventListener("click"');
  });

  it("has real elements for Copy and both links, for the keyboard and screen readers", () => {
    expect(html).toContain('<button type="button" id="copy-install">');
    expect(html).toContain('getElementById("copy-install")');
    expect(html).toContain('<a href="/bots">');
  });

  it("links GitHub in a new tab and the bot docs to a page that does not exist yet", () => {
    expect(html).toContain('window.open(`https://github.com/${REPO}`, "_blank", "noopener")');
    expect(html).toContain('location.href = "/bots"');
    expect(html).toContain('<a href="/bots">');
    expect(html).toContain('href="https://github.com/craftmilldev/loopway" target="_blank"');
  });

  it("keeps finds in localStorage and only sends a first find", () => {
    expect(html).toContain('const KEPT = "loopway.found"');
    expect(html).toContain("if (kept()[what]) return;");
    // The tracker is painted on the last frame only.
    const last = html.slice(html.indexOf("Small print under the main content"));
    expect(last).toContain('[262, ["snake", "bird", "hummingbird", "moth", "moose"]],');
    expect(last).toContain('[286, ["squirrel", "blackbird", "skunk", "trout"]],');
    expect(last).toContain("loops completed:");
    expect(html.match(/loops completed:/g)).toHaveLength(1);
  });

  it("sends a moose to eat the cattails before midday or midnight, and only its box unticks", () => {
    expect(html).toContain("!mooseAte && MOOSE.start === null && mod(daylight(dayNow()).sunU + 0.06, 0.5) < 0.31;");
    expect(html).toContain('if (what === "moose") MOOSE.start = clockNow();');
    // The bunch stays eaten: what is kept decides it, on this visit and the next.
    expect(html).toContain("mooseAte = !!kept().moose;");
    // Only a ticked moose box is a button, and all it does is untick.
    expect(html.match(/hit\("moose"/g)).toHaveLength(1);
    expect(html).toContain('if (name === "moose" && found.moose && MOOSE.start === null)');
    expect(html).toContain("keep({ moose: false });");
    expect(html).toContain('track("moose_unchecked");');
  });

  it("ticks off the ones that come by on their own when they are first seen, and sends nothing", () => {
    for (const name of ["squirrel", "blackbird", "skunk", "trout"]) expect(html).toContain(`see("${name}");`);
    // Seeing keeps the tick and stops there: only found() sends an event.
    const see = html.slice(html.indexOf("function see(what) {"), html.indexOf("function found(what) {"));
    expect(see).toContain("if (!kept()[what]) keep({ [what]: true });");
    expect(see).not.toContain("track(");
    for (const name of ["snake", "bird", "hummingbird", "moth", "moose"])
      expect(html).toContain(
        `if (what === "${name}") ${name === "hummingbird" ? "HUMMER" : name.toUpperCase()}.start = clockNow();`,
      );
    expect(html).not.toMatch(/keep\(\{ (snake|bird|hummingbird|moth): false \}\)/);
  });

  it("sends a hummingbird to the freshly opened morning glory, and only then", () => {
    expect(html).toContain("return u >= 0.13 && u <= 0.16 + (5 * speed) / T;");
    expect(html).toContain('if (what === "hummingbird") HUMMER.start = clockNow();');
    expect(html).toContain('drawHummer(ctx, clock, "behind");\n        drawBoard(ctx);');
  });

  it("sends a moth from the open moonflower to the red chair when all three are at the fire", () => {
    expect(html).toContain("moonflowerOpen(u - MOTH_FLOWER.delay) > 0.9 &&");
    expect(html).toContain("sits(worker(u), SEAT1) &&");
    expect(html).toContain("sits(middle(u), SEAT2) &&");
    expect(html).toContain("sits(sleeper(u), SEAT3)");
    expect(html).toContain("const dev = swatting(worker(u), clock);");
    expect(html).toContain('if (what === "moth") MOTH.start = clockNow();');
  });

  it("steps one frame per flick, and ignores only Space on a button or link", () => {
    expect(html).toContain("now - lastWheel > 120");
    expect(html).toContain("Math.abs(wheelSum) >= 10");
    // The camera does not move: all of the animation stays in view.
    expect(html).not.toContain("cameraTo");
    expect(html).toContain('event.key === " " && event.target.closest && event.target.closest("button, a")');
  });

  it("links the bot docs from the get-started frame, to a page that explains the bot files", () => {
    expect(html).toContain('<a href="/bots">');
    expect(html).toContain('location.href = "/bots"');
    const bots = readFileSync(new URL("../public/bots.html", import.meta.url), "utf8");
    expect(bots).toContain("<title>loopway bots</title>");
    expect(bots).toContain('<a href="/">');
    expect(bots).not.toMatch(/<script\b/);
    for (const key of ["repos", "on", "model", "harness", "allow", "deny"]) {
      expect(bots).toContain(`<code>${key}</code>`);
    }
    expect(bots).toContain(".loopway/dev.md");
    expect(bots).toContain(".loopway/review.md");
  });

  it("is what vercel.json serves, with no build step", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config.outputDirectory).toBe("public");
    expect(config.buildCommand).toBeNull();
    expect(config.cleanUrls).toBe(true);
    expect(config.crons).toBeUndefined();
  });
});
