// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LevelPie } from "../client/level-pie.js";

afterEach(cleanup);

describe("LevelPie", () => {
  it("shows an ellipsis while activity is loading", () => {
    render(<LevelPie levels={undefined} />);
    expect(screen.getByText("…")).toBeTruthy();
  });

  it("says so when the bot has no threads", () => {
    render(<LevelPie levels={{ 2: 0, 3: 0, 4: 0 }} />);
    expect(screen.getByText("No threads")).toBeTruthy();
  });

  it("describes the share at each level", () => {
    render(<LevelPie levels={{ 2: 2, 3: 1, 4: 1 }} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("50% level 2, 25% level 3, 25% level 4");
  });

  it("lists the counts next to a large pie", () => {
    render(<LevelPie levels={{ 2: 3, 3: 0, 4: 0 }} size={120} />);
    expect(screen.getByText("Level 2 · 3")).toBeTruthy();
  });
});
