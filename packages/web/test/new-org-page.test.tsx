// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "../client/metrics.js";
import { NewOrg } from "../client/new-org.js";

vi.mock("../client/metrics.js", () => ({ track: vi.fn(), identify: vi.fn(), reset: vi.fn() }));

let posts: unknown[];
let assigned: string[];
let userOrgs: { id: string; slug: string; name: string; personal: boolean }[];

beforeEach(() => {
  userOrgs = [
    { id: "o1", slug: "me", name: "me", personal: true },
    { id: "o2", slug: "acme", name: "acme", personal: false },
  ];
  localStorage.setItem("loopway_token", "t");
  posts = [];
  assigned = [];
  const real = window.location;
  vi.stubGlobal("location", {
    origin: real.origin,
    pathname: "/orgs/new",
    search: "",
    replace: vi.fn(),
    assign: (to: string) => assigned.push(to),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string, init?: RequestInit) => {
      const path = apiPath.replace(/^\/api/, "");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === "/me") return json({ id: "u1", email: null, name: "Me", username: "me" });
      if (path === "/orgs" && init?.method === "GET") return json({ data: userOrgs });
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        posts.push(body);
        return json({ id: "o9", slug: body.slug, name: body.slug, personal: false }, 201);
      }
      const slug = path.split("/")[2]!;
      return json(
        slug === "taken"
          ? { slug, available: false, reason: "taken", message: "That slug is taken" }
          : { slug, available: true },
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("NewOrg", () => {
  it("shows only the masthead for a user with no org", async () => {
    userOrgs = [];
    localStorage.removeItem("loopway_last_org");
    const { container } = render(<NewOrg />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Org:/ })).toBeNull());
    await waitFor(() => expect(container.querySelector(".dash-nav")).toBeNull());
    expect(screen.getByRole("link", { name: "Loopway" }).getAttribute("href")).toBe("/dashboard");
    expect(screen.queryByText("New bot")).toBeNull();
    expect(screen.getByText("Log out")).toBeTruthy();
  });

  it("has the dashboard masthead, with every link pointing at the last org", async () => {
    localStorage.setItem("loopway_last_org", "acme");
    const { container } = render(<NewOrg />);
    await screen.findByRole("button", { name: /Org: acme/ });
    expect(container.querySelector(".post-nav")).toBeNull();
    expect(container.querySelector(".dash-head")).toBeTruthy();
    expect(screen.getByText("Log out")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Start an org" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Org: acme/ }));
    const hrefs = Array.from(container.querySelectorAll("a[href]"), (a) => a.getAttribute("href")!).filter(
      (h) => h !== "#",
    );
    expect(hrefs).toContain("/acme/bots/new");
    expect(hrefs).toContain("/acme/bots");
    expect(hrefs).toContain("/me");
    for (const h of hrefs) expect(h).toMatch(/^\/(acme|me|orgs\/new)(\/|$)/);
    expect(container.querySelector(".dash-nav .on")).toBeNull();
  });

  it("shows a taken slug before submit and blocks it", async () => {
    render(<NewOrg />);
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "taken" } });
    expect(await screen.findByText("That slug is taken")).toBeTruthy();
    expect(track).toHaveBeenCalledWith("org_slug_unavailable", { reason: "taken" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create org" }).disabled).toBe(true);
  });

  it("creates the org and goes to its page", async () => {
    render(<NewOrg />);
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "fresh" } });
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Fresh Co" } });
    expect(await screen.findByText("Available")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create org" }).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText("Create org"));
    await waitFor(() => expect(assigned).toEqual(["/fresh"]));
    expect(posts).toEqual([{ slug: "fresh", name: "Fresh Co" }]);
    expect(localStorage.getItem("loopway_last_org")).toBe("fresh");
  });
});
