// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashLayout, Layout } from "../client/layout.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the wordmark", () => {
  it("is the labelled home link in the public frame", () => {
    const { container } = render(<Layout title="Log in">x</Layout>);
    expect(screen.getByRole("link", { name: "Loopway" }).getAttribute("href")).toBe("/");
    expect(container.querySelector(".post-nav svg.loopway-wordmark")).toBeTruthy();
  });

  it("is the labelled overview link in the dashboard masthead, not text", () => {
    history.pushState({}, "", "/acme/bots");
    const { container } = render(
      <DashLayout title="Bots" me={null}>
        x
      </DashLayout>,
    );
    expect(screen.getByRole("link", { name: "Loopway" }).getAttribute("href")).toBe("/acme");
    expect(container.querySelector(".dash-head svg.loopway-wordmark")).toBeTruthy();
    expect(screen.queryByText("LOOPWAY")).toBeNull();
  });
});
