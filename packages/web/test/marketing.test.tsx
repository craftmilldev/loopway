// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { marketingPage } from "../client/marketing.js";
import { MARKETING_PATHS, marketingSlugs } from "../src/marketing.js";
import { RESERVED_SLUGS, slugProblem } from "../src/slugs.js";
import { createWeb } from "../src/ui.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.doUnmock("../src/marketing.js");
  vi.resetModules();
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

describe("reserved slugs from the marketing list", () => {
  it("takes the first segment of each path, none for the home", () => {
    expect(marketingSlugs(["/", "/features", "/tour/intro"])).toEqual(["features", "tour"]);
    expect(marketingSlugs(MARKETING_PATHS)).toEqual([]);
  });

  it("keeps the existing reserved slugs", () => {
    for (const word of ["api", "dashboard", "login", "about", "loopway"]) expect(RESERVED_SLUGS.has(word)).toBe(true);
  });

  it("serves a page added to the list and reserves its name", async () => {
    expect(slugProblem("features")).toBeUndefined();
    vi.resetModules();
    vi.doMock("../src/marketing.js", async (orig) => ({
      ...(await orig<typeof import("../src/marketing.js")>()),
      MARKETING_PATHS: ["/", "/features"],
    }));
    const { slugProblem: problem } = await import("../src/slugs.js");
    const { createWeb: create } = await import("../src/ui.js");
    expect(problem("features")).toBe("reserved");
    expect((await create().request("/features")).status).toBe(200);
    expect((await createWeb().request("/features")).status).toBe(404);
  });
});
