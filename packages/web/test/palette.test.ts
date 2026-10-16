import { readFileSync } from "node:fs";
import { LEVEL_COLORS, STATE_COLORS, type State } from "@loopway/palette";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");

/** Every rule's selectors and declarations, in order. */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  selectors: sel!.split(",").map((s) => s.trim()),
  decls: Object.fromEntries(
    body!
      .split(";")
      .map((d) => d.split(":").map((s) => s.trim()))
      .filter(([k, v]) => k && v),
  ) as Record<string, string>,
}));

/** A custom property's value, from the last `:root` that declares it. */
const token = (name: string): string | undefined =>
  rules.findLast((r) => r.selectors.includes(":root") && r.decls[name])?.decls[name];

/** The color the last rule matching one of `selectors` gives, with `var()`s resolved. */
function color(...selectors: string[]): string | undefined {
  const value = rules.findLast((r) => r.selectors.some((s) => selectors.includes(s)) && r.decls.color)?.decls.color;
  const v = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return (v ? token(v) : value)?.toLowerCase();
}

describe("the dashboard's status colors", () => {
  for (const state of Object.keys(STATE_COLORS) as State[]) {
    it(`gives a ${state} badge and dot @loopway/palette's paper value`, () => {
      const paper = STATE_COLORS[state].paper;
      expect(color(`.state-${state}`) ?? color(".state")).toBe(paper);
      expect(color(`.dot.state-${state}`) ?? color(".dot")).toBe(paper);
    });
  }
});

describe("the level pie's colors", () => {
  // LevelPie reads the palette, so its slices only match the rest of the dashboard while these tokens do.
  const tokens = { 2: "--ink-300", 3: "--indigo-600", 4: "--madder-600" } as const;
  for (const level of [2, 3, 4] as const)
    it(`gives level ${level} styles.css's ${tokens[level]}`, () => {
      expect(token(tokens[level])?.toLowerCase()).toBe(LEVEL_COLORS[level].paper);
    });
});
