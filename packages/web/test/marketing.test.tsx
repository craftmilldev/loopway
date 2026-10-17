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

describe("GET / on a self-hosted deploy", () => {
  it("redirects to /login and records it", async () => {
    const captured: string[] = [];
    const app = createWeb({ selfHosted: true, metrics: { capture: async (event) => void captured.push(event) } });
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(captured).toEqual(["home_redirected_to_login"]);
    expect((await app.request("/login")).status).toBe(200);
  });
});

describe("the marketing home", () => {
  it("shows Log in to an anonymous visitor", () => {
    render(marketingPage("/"));
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Log in" })).toBeTruthy();
  });

  it("shows the same page with Dashboard to a signed-in visitor", () => {
    localStorage.setItem("loopway_token", "t");
    render(marketingPage("/"));
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe(
      "/dashboard",
    );
    expect(within(screen.getByRole("navigation")).queryByRole("link", { name: "Log in" })).toBeNull();
  });

  it("shows how to install the CLI with the install.sh link", () => {
    const { container } = render(marketingPage("/"));
    expect(container.querySelector("#top .lp-well")?.textContent).toContain(
      "curl -fsSL https://loopway.craftmill.dev/install.sh | sh",
    );
  });

  it("links the top bar to the page's sections, by their labels", () => {
    const { container } = render(marketingPage("/"));
    const links = within(screen.getByRole("navigation")).getAllByRole("link");
    const anchors = links.filter((a) => a.getAttribute("href")!.startsWith("#"));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["#levels", "#bots", "#how", "#dashboard", "#sources"]);
    for (const a of anchors) {
      const section = container.querySelector(a.getAttribute("href")!)!;
      expect(a.textContent).toBe(section.querySelector(".lp-label")!.textContent);
    }
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
