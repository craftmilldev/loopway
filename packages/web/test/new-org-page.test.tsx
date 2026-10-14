// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "../client/metrics.js";
import { NewOrg } from "../client/new-org.js";

vi.mock("../client/metrics.js", () => ({ track: vi.fn(), identify: vi.fn(), reset: vi.fn() }));

let posts: unknown[];
let assigned: string[];

beforeEach(() => {
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
