// @vitest-environment jsdom
import { LEVEL_COLORS, STATE_COLORS } from "@loopway/palette";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LedeTerminal } from "../client/lede-terminal.js";

afterEach(cleanup);

const ours = [
  "loopway-dev",
  "loopway-review",
  "loopway-epic",
  "loopway-requests",
  "prod-deploy-errors",
  "model-updater",
  "call-learnings",
];
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

describe("LedeTerminal", () => {
  it("shows the sample bots and none of ours", () => {
    const { container } = render(<LedeTerminal />);
    const text = container.textContent ?? "";
    for (const bot of ["issue-to-pr", "second-look", "deploy-medic"]) expect(text).toContain(bot);
    for (const bot of ours) expect(text).not.toContain(bot);
    expect(text.toLowerCase()).not.toContain("claude");
  });

  it("colors its marks from the palette", () => {
    const { container } = render(<LedeTerminal />);
    const colors = [...container.querySelectorAll<HTMLElement>("[style]")].map((e) => e.style.color);
    expect(colors.length).toBeGreaterThan(0);
    const ok = new Set(
      [
        STATE_COLORS.working.ink,
        STATE_COLORS.waiting.ink,
        LEVEL_COLORS[2].ink,
        LEVEL_COLORS[3].ink,
        LEVEL_COLORS[4].ink,
      ].map(rgb),
    );
    for (const c of colors) expect(ok.has(c)).toBe(true);
  });

  it("has no hard-coded status hex values", () => {
    const src = readFileSync(join(import.meta.dirname, "../client/lede-terminal.tsx"), "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});
