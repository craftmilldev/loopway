import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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
    // A frozen day is never redrawn, so the hint rests instead of being caught part-way through a wiggle.
    expect(html).toContain("freeze === null ? clockNow() % 3.5 : 1.5");
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
    // In the order of the day, with the secret dead fish last and only once it is earned.
    const order = ["snake", "bird", "moose", "trout", "eagle", "hummingbird", "squirrel", "blackbird", "moth", "skunk"];
    const listed = last.slice(last.indexOf("const names = ["), last.indexOf("];", last.indexOf("const names = [")));
    expect([...listed.matchAll(/^\s+"(\w+)",$/gm)].map((m) => m[1])).toEqual(order);
    expect(last).toContain('const label = name === "bird" ? "chickadee" : name;');
    // The dead fish are not a box: three fish, one for each trout, and nothing at all until one is caught.
    expect(last).toContain("if (found.deadfish) {");
    expect(last).toContain("for (const when of FISH) {");
    expect(html).toContain('const FISH = ["dawn", "dusk", "night"];');
    expect(html).toContain("found(`deadfish_${EAGLE.fish}`);");
    // They can be given up with a click, all three at once.
    expect(html).toContain(
      "keep({ deadfish: false, deadfish_dawn: false, deadfish_dusk: false, deadfish_night: false });",
    );
    expect(html).toContain('track("deadfish_unchecked");');
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

  it("sends an eagle after a jumping trout: a catch in the middle second, a miss either side", () => {
    // Too far from the perfect moment and it does not fly; within half a second of it, it catches.
    expect(html).toContain("if (Math.abs(late) > 1.5) continue;");
    expect(html).toContain("const hit = Math.abs(late) <= 0.5;");
    expect(html).toContain('if (what === "eagle") launchEagle();');
    // A trout that is taken does not come down, and makes no splash going in.
    expect(html).toContain("[entryX, taken ? -1 : p - 1],");
    expect(html).toContain("if (p > 1 || taken) continue;");
    // The catch is what earns the secret box.
    expect(html).toContain('found("deadfish");');
  });

  it("forgets everything on three quick clicks on the loop count", () => {
    expect(html).toContain('hit("reset", right - ctx.measureText(loops).width - 6, 266, right + 6, 296);');
    expect(html).toContain("resetClicks = [...resetClicks.filter((at) => now - at < 1), now];");
    expect(html).toContain("if (resetClicks.length < 3) return;");
    expect(html).toContain(
      'keep(Object.fromEntries(Object.keys(memory).map((key) => [key, key === "loops" ? 0 : false])));',
    );
    expect(html).toContain('track("tracker_reset");');
  });

  it("puts the log on the fire: let go, dropped in, and left there to burn", () => {
    expect(html).toContain("carry: u < LOG.let ? 1 : 0");
    expect(html).toContain("const flying = u >= LOG.let && u < LOG.lands;");
    expect(html).not.toContain("carry: 1 - smooth(0.25, 0.5, s)");
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

  it("fits the picture to the window: a wide window keeps the desk, the sign and the camp together, and a tall one is a camera", () => {
    const source = html.match(/const FULL = [\s\S]*?return \{ s, x: -left \* s, y: -top \* s, tall \};\n {6}\}/)?.[0];
    expect(source).toBeDefined();
    type Box = { x0: number; y0: number; x1: number; y1: number };
    type View = { s: number; x: number; y: number; tall: boolean };
    const { FULL, KEEP, fit } = runInNewContext(`${source}; ({ FULL, KEEP, fit })`, {
      W: 1600,
      H: 1000,
    }) as { FULL: Box; KEEP: Box; fit: (w: number, h: number) => View };
    // What a window w by h shows of the picture, and how much of the window is bars.
    const shown = (w: number, h: number) => {
      const view = fit(w, h);
      const box = { x0: -view.x / view.s, y0: -view.y / view.s, x1: (w - view.x) / view.s, y1: (h - view.y) / view.s };
      const bars = {
        x: Math.max(0, FULL.x0 - box.x0) + Math.max(0, box.x1 - FULL.x1),
        y: Math.max(0, FULL.y0 - box.y0) + Math.max(0, box.y1 - FULL.y1),
      };
      return { view, box, bars };
    };
    const holds = (box: Box, keep: Box) =>
      box.x0 <= keep.x0 + 1e-6 && box.y0 <= keep.y0 + 1e-6 && box.x1 >= keep.x1 - 1e-6 && box.y1 >= keep.y1 - 1e-6;
    // Laptops, monitors, an ultrawide, a phone or a tablet on its side, a square window: all of it
    // picture, no bars.
    for (const [w, h] of [
      [1600, 1000],
      [1440, 900],
      [1920, 1080],
      [1366, 768],
      [2560, 1080],
      [844, 390],
      [1500, 1000],
      [1024, 768],
      [1280, 1024],
      [1000, 1000],
    ] as [number, number][]) {
      const { view, box, bars } = shown(w, h);
      expect(view.tall).toBe(false);
      expect(holds(box, KEEP)).toBe(true);
      expect(bars.x).toBeCloseTo(0);
      expect(bars.y).toBeCloseTo(0);
    }
    // Wider than all that is painted: the kept part fills the height, and the bars are at the sides only.
    for (const [w, h] of [
      [3840, 1080],
      [5120, 1440],
    ] as [number, number][]) {
      const { box, bars } = shown(w, h);
      expect(holds(box, KEEP)).toBe(true);
      expect(box.y0).toBeCloseTo(KEEP.y0);
      expect(box.y1).toBeCloseTo(KEEP.y1);
      expect(bars.y).toBeCloseTo(0);
      expect(bars.x).toBeGreaterThan(0);
    }
    // Held upright it is a camera: wherever it looks, that part fills the width, with no bars
    // in a phone's browser. On the desk it holds the desk and its computer, on the sign the whole
    // sign, and on the camp the three seats at the fire and the tent.
    const fitAt = fit as unknown as (w: number, h: number, look: number) => View;
    for (const [w, h] of [
      [390, 664],
      [412, 780],
      [768, 1024],
    ] as [number, number][]) {
      for (const [look, x0, x1] of [
        [322, 60, 300],
        [622, 184, 1062],
        [1236, 1150, 1660],
      ] as [number, number, number][]) {
        const view = fitAt(w, h, look);
        expect(view.tall).toBe(true);
        const left = -view.x / view.s;
        const right = (w - view.x) / view.s;
        expect(left).toBeLessThanOrEqual(x0);
        expect(right).toBeGreaterThanOrEqual(x1);
        expect(left).toBeGreaterThanOrEqual(FULL.x0);
        expect(right).toBeLessThanOrEqual(FULL.x1);
        expect(-view.y / view.s).toBeGreaterThanOrEqual(FULL.y0 - 1e-6);
        expect((h - view.y) / view.s).toBeLessThanOrEqual(FULL.y1 + 1e-6);
      }
      expect(fit(w, h)).toEqual(fitAt(w, h, 622));
    }
    // The camera's round: on the worker until they have sat down at the fire, then the sign, then
    // back to the desk; and on the sign whenever a face other than the first is showing.
    expect(html).toContain(
      "const CAMERA = { x: null, at: 0, from: 322, to: 1236, leaves: 0.56, onSign: [0.64, 0.93] };",
    );
    expect(html).toContain("if (shown > 0) return SIGN_MIDDLE;");
    expect(html).toContain("if (u < CAMERA.leaves) return clamp(worker(u).x, CAMERA.from, CAMERA.to);");
    expect(html).toContain("if (view.tall) moveCamera(u);");
    // The blackbird comes in low over the water: its whole flight is well inside the kept part.
    const lows = [...html.matchAll(/\[0(?:\.\d+)?, -?\d+, (9\d\d)\],/g)].map((m) => Number(m[1]));
    expect(lows).toContain(965);
    expect(KEEP.y1 - Math.max(...lows)).toBeGreaterThanOrEqual(30);
    // Whoever comes and goes does so beyond what the window sees, not beyond the old picture.
    for (const line of [
      "WALK_IN[0][0] = sides.left - 90;",
      "const skunkOut = () => [sides.left - 90, 678];",
      "const mooseEdge = () => [sides.right + 190, 938 - (sides.right - W) * 0.036];",
      "const away = [sides.right + 150,",
      "[[0, sides.left - 70, 968]]",
      "[[1, sides.right + 100, 790 - further * 0.1]]",
    ]) {
      expect(html).toContain(line);
    }
    expect(html).toContain("if (view.tall) drawTurnHint(main);");
    expect(html).toContain('"TURN FOR THE WHOLE SCENE"');
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

  it("asks for the hummingbird's flower before the snake's rock, which it half covers", () => {
    expect(html.indexOf('return "hummingbird"')).toBeLessThan(html.indexOf('return "snake"'));
  });

  it("repaints the tracker whenever what is kept changes, and the docs name every event it sends", () => {
    expect(html).toContain("if (shown === FRAMES.length - 1) redrawFace();");
    const docs = readFileSync(new URL("../../../docs/developing.md", import.meta.url), "utf8");
    for (const name of [
      "deadfish_dawn_found",
      "deadfish_dusk_found",
      "deadfish_night_found",
      "deadfish_unchecked",
      "moose_unchecked",
      "tracker_reset",
    ]) {
      expect(docs).toContain(name);
    }
  });
});
