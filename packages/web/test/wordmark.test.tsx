// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Wordmark } from "../client/marketing.js";

afterEach(cleanup);

describe("the wordmark", () => {
  it("is the labelled home link, not text", () => {
    const { container } = render(<Wordmark href="/" />);
    expect(screen.getByRole("link", { name: "Loopway" }).getAttribute("href")).toBe("/");
    expect(container.querySelector("svg.loopway-wordmark")).toBeTruthy();
    expect(screen.queryByText("LOOPWAY")).toBeNull();
  });
});
