// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT, marketingPage } from "../client/marketing.js";
import { slugProblem } from "../src/slugs.js";
import { createWeb } from "../src/ui.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("GET /", () => {
  it("serves the marketing shell without a redirect, whatever the visitor's cookies", async () => {
    const app = createWeb();
    for (const headers of [{} as Record<string, string>, { cookie: "session=x", authorization: "Bearer lw_x" }]) {
      const res = await app.request("/", { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  });
});

describe("the marketing home", () => {
  it("shows Log in to an anonymous visitor", () => {
    render(marketingPage("/"));
    expect(screen.getByRole("heading", { name: "Make a bot" })).toBeTruthy();
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Log in" })).toBeTruthy();
  });

  it("shows the same page with Dashboard to a signed-in visitor", () => {
    localStorage.setItem("loopway_token", "t");
    render(marketingPage("/"));
    expect(screen.getByRole("heading", { name: "Make a bot" })).toBeTruthy();
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe(
      "/dashboard",
    );
    expect(within(screen.getByRole("navigation")).queryByRole("link", { name: "Log in" })).toBeNull();
  });

  it("isn't a page for other paths", () => {
    expect(marketingPage("/nope")).toBeNull();
  });
});

describe("marketing pages and org slugs", () => {
  it("reserves the first segment of every marketing path", () => {
    for (const path of Object.keys(CONTENT)) {
      const slug = path.split("/")[1]!;
      if (slug) expect(slugProblem(slug), path).toBe("reserved");
    }
  });
});
