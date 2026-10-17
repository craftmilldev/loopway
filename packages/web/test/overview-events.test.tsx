// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadEventsFeed } from "../client/overview.js";

const event = (id: string, over: object = {}) => ({
  id,
  kind: "started",
  at: new Date().toISOString(),
  bot_id: "b1",
  bot_name: "dev",
  thread_id: "t" + id,
  subjects: ["acme/app#1"],
  title: null,
  ...over,
});

const longAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
let pages: Record<string, object>;
let requests: string[];

beforeEach(() => {
  window.history.replaceState(null, "", "/acme");
  localStorage.setItem("loopway_token", "t");
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string) => {
      const path = apiPath.replace(/^\/api/, "");
      requests.push(path);
      const key = new URLSearchParams(path.split("?")[1]).get("before") ?? "first";
      return new Response(JSON.stringify(pages[key] ?? { data: [], next: null }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThreadEventsFeed", () => {
  it("keeps the empty state when there are no events", async () => {
    pages = { first: { data: [], next: null } };
    render(<ThreadEventsFeed ready />);
    expect(await screen.findByText(/Nothing to show yet/)).toBeTruthy();
    expect(screen.queryByText("Older")).toBeNull();
  });

  it("lists today's events with a bot and a link to the thread", async () => {
    pages = {
      first: {
        data: [event("2", { kind: "ended", title: "Fix login" }), event("1", { kind: "limited" })],
        next: null,
      },
    };
    render(<ThreadEventsFeed ready />);
    const link = await screen.findByText("Fix login");
    expect(link.getAttribute("href")).toBe("/acme/bots/b1/threads/t2");
    expect(screen.getByText(/ended a thread/)).toBeTruthy();
    expect(screen.getByText(/hit its usage limit/)).toBeTruthy();
    expect(screen.getByText("acme/app#1").getAttribute("href")).toBe("/acme/bots/b1/threads/t1");
    expect(screen.queryByText("Older")).toBeNull();
  });

  it("pages ten at a time with Older and Newer", async () => {
    pages = {
      first: { data: [event("3"), event("2", { subjects: ["acme/app#2"] })], next: "2" },
      "2": { data: [event("1", { at: longAgo, subjects: ["acme/app#3"] })], next: null },
    };
    render(<ThreadEventsFeed ready />);
    await screen.findByText("acme/app#1");
    expect(screen.queryByText("Newer")).toBeNull();
    fireEvent.click(screen.getByText("Older"));
    await screen.findByText("acme/app#3");
    expect(screen.queryByText("acme/app#2")).toBeNull();
    expect(screen.queryByText("Older")).toBeNull();
    expect(requests.slice(0, 2)).toEqual(["/events?limit=10&org=acme", "/events?limit=10&before=2&org=acme"]);
    fireEvent.click(screen.getByText("Newer"));
    await screen.findByText("acme/app#2");
    expect(screen.queryByText("Newer")).toBeNull();
  });
});
