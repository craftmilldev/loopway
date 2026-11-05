import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");

describe("styles.css", () => {
  it("defines every custom property it uses", () => {
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((name) => !css.includes(`${name}:`))).toEqual([]);
  });
});
