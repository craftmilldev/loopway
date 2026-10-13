import { describe, expect, it } from "vitest";
import { deliveredIn } from "../client/activity.js";

const bot = (counts: number[]) => ({ days: counts.map((delivered) => ({ delivered })) });

describe("deliveredIn", () => {
  it("sums the last N days over all bots, so each range shows a different figure", () => {
    const bots = [bot([5, 0, 0, 0, 0, 0, 2, 1]), bot([3, 0, 0, 0, 0, 0, 0, 4])];
    expect(deliveredIn(bots, 1)).toBe(5);
    expect(deliveredIn(bots, 2)).toBe(7);
    expect(deliveredIn(bots, 7)).toBe(7);
    expect(deliveredIn(bots, 8)).toBe(15);
  });
  it("is zero without bots", () => {
    expect(deliveredIn([], 7)).toBe(0);
  });
});
