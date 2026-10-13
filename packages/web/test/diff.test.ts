import { describe, expect, it } from "vitest";
import { changed, lineDiff } from "../client/diff.js";

describe("lineDiff", () => {
  it("keeps equal text as unchanged lines", () => {
    const d = lineDiff("a\nb", "a\nb");
    expect(d).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
    expect(changed(d)).toBe(false);
  });

  it("marks a replaced line as an addition and a removal", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "add", text: "B" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("finds inserted and removed lines", () => {
    const kinds = (a: string, b: string) => lineDiff(a, b).map((l) => l.kind + ":" + l.text);
    expect(kinds("a\nc", "a\nb\nc")).toEqual(["same:a", "add:b", "same:c"]);
    expect(kinds("a\nb\nc", "a\nc")).toEqual(["same:a", "del:b", "same:c"]);
  });

  it("treats empty text as no lines", () => {
    expect(lineDiff("", "x")).toEqual([{ kind: "add", text: "x" }]);
    expect(lineDiff("x", "")).toEqual([{ kind: "del", text: "x" }]);
    expect(lineDiff("", "")).toEqual([]);
    expect(changed(lineDiff("x", ""))).toBe(true);
  });
});
