// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  localStorage.setItem("loopway_token", "t");
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      requests.push(path);
      const key = path.includes("before=") ? path.split("before=")[1]! : "first";
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
    expect(screen.queryByText("Show earlier")).toBeNull();
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
    expect(link.getAttribute("href")).toBe("/dashboard/bots/b1/threads/t2");
    expect(screen.getByText(/ended a thread/)).toBeTruthy();
    expect(screen.getByText(/hit its usage limit/)).toBeTruthy();
    expect(screen.getByText("acme/app#1").getAttribute("href")).toBe("/dashboard/bots/b1/threads/t1");
    expect(screen.queryByText("Show earlier")).toBeNull();
  });

  it("hides earlier days until Show earlier, which loads the next page", async () => {
    pages = {
      first: { data: [event("3"), event("2", { at: longAgo, subjects: ["acme/app#2"] })], next: "2" },
      "2": { data: [event("1", { at: longAgo, subjects: ["acme/app#3"] })], next: null },
    };
    render(<ThreadEventsFeed ready />);
    await screen.findByText("acme/app#1");
    expect(screen.queryByText("acme/app#2")).toBeNull();
    fireEvent.click(screen.getByText("Show earlier"));
    await screen.findByText("acme/app#3");
    expect(screen.getByText("acme/app#2")).toBeTruthy();
    expect(requests).toEqual(["/events", "/events?before=2"]);
    await waitFor(() => expect(screen.queryByText("Show earlier")).toBeNull());
  });
});
