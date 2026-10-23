import { describe, expect, it } from "vitest";
import { diagramBoxes } from "../client/zero-state.js";

describe("zero-state diagram", () => {
  it("lists the parts in the order of the setup steps", () => {
    expect(diagramBoxes(1).map((b) => b.step)).toEqual([1, 2, 3]);
  });

  it("inks the part a step sets up, checks earlier parts and leaves later ones plain", () => {
    expect(diagramBoxes(1).map((b) => b.state)).toEqual(["now", "later", "later"]);
    expect(diagramBoxes(2).map((b) => b.state)).toEqual(["done", "now", "later"]);
    expect(diagramBoxes(3).map((b) => b.state)).toEqual(["done", "done", "now"]);
  });

  it("names the parts once they exist", () => {
    const titles = diagramBoxes(3, { runner: "laptop", service: "GitHub" }).map((b) => b.title);
    expect(titles).toEqual(["runner laptop, with your coding agent", "create bot", "GitHub"]);
  });
});
