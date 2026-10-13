// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runsOf, Thread } from "../client/bot.js";

const msg = (id: string, over: object = {}) => ({
  id,
  inbox_id: "i1",
  type: "com.github.issue_comment.created",
  subject: null,
  summary: `mcwhittemore commented on #156: ${id}`,
  ...over,
});
const delivered = (id: string, at: string, over: object = {}) => ({
  id,
  inbox_id: "i1",
  type: "com.github.issues.opened",
  key: null,
  delivered_at: at,
  summary: `alice opened issue #1: ${id}`,
  ...over,
});
const thread = (over: object = {}) => ({
  id: "t1",
  bot_id: "b1",
  title: "Redesign the dashboard",
  status: "active",
  started: true,
  interrupted: false,
  limited: false,
  runner_id: "r1",
  subjects: ["acme/app#156", "acme/app#170"],
  waiting: [],
  inflight: [],
  delivered: 0,
  delivered_messages: [],
  created_at: "2026-10-12T08:00:00Z",
  updated_at: "2026-10-12T09:00:00Z",
  ...over,
});

let current: object;
let online: boolean;
let requests: string[];
let endFails: boolean;

beforeEach(() => {
  localStorage.setItem("loopway_token", "t");
  online = true;
  endFails = false;
  requests = [];
  current = thread();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${path}`);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === "/me") return json({ id: "u1", email: null, name: "Me" });
      if (path === "/bots/b1") return json({ id: "b1", name: "dev", prompt_version: { version: 3 } });
      if (path === "/bots/b1/threads/t1") return json(current);
      if (path === "/bots/b1/threads/t1/release") {
        current = thread({ runner_id: null });
        return json(current);
      }
      if (path === "/bots/b1/threads/t1/end") {
        if (endFails) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
        current = thread({ status: "ended" });
        return json(current);
      }
      if (path === "/runners")
        return json({ data: [{ id: "r1", name: "laptop", leased_until: online ? "2026-10-13T00:00:00Z" : null }] });
      if (path === "/inboxes/i1/messages/w1") return json({ event: { type: "x", data: { hello: "world" } } });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runsOf", () => {
  it("groups by delivery time, newest run first and numbered oldest first", () => {
    const runs = runsOf([
      delivered("a", "2026-10-12T08:00:00Z"),
      delivered("b", "2026-10-12T08:00:00Z"),
      delivered("c", "2026-10-12T09:00:00Z"),
    ]);
    expect(runs.map((r) => [r.number, r.messages.map((m) => m.id)])).toEqual([
      [2, ["c"]],
      [1, ["a", "b"]],
    ]);
  });
});

describe("runsOf with no delivery time", () => {
  it("sorts a missing time first", () => {
    const runs = runsOf([delivered("a", "2026-10-12T08:00:00Z"), { ...delivered("b", "x"), delivered_at: null }]);
    expect(runs.map((r) => r.messages[0]!.id)).toEqual(["a", "b"]);
  });
});

describe("Thread page", () => {
  it("shows the title, subject chips, state and the side column", async () => {
    current = thread({ waiting: [msg("w1")] });
    render(<Thread botId="b1" id="t1" />);
    expect(await screen.findByRole("heading", { name: "Redesign the dashboard" })).toBeTruthy();
    const chips = screen.getAllByText(/^acme\/app#/);
    expect(chips.map((c) => c.getAttribute("href"))).toEqual([
      "https://github.com/acme/app/issues/156",
      "https://github.com/acme/app/issues/170",
    ]);
    await screen.findByText("waiting");
    const side = screen.getByLabelText("Thread details");
    expect(side.textContent).toContain("laptop");
    expect(side.textContent).toContain("v3");
    expect(side.textContent).toContain("tail -f ~/.loopway/threads/t1.log");
  });

  it("shows waiting messages as a summary over the event type, and opens the event JSON", async () => {
    current = thread({ waiting: [msg("w1")] });
    render(<Thread botId="b1" id="t1" />);
    await screen.findByText("mcwhittemore commented on #156: w1");
    expect(screen.getByText("com.github.issue_comment.created")).toBeTruthy();
    // jsdom doesn't toggle <details> on a click, so open it and fire the event the browser would.
    document.querySelector("details")!.open = true;
    fireEvent(document.querySelector("details")!, new Event("toggle"));
    await waitFor(() => expect(document.querySelector("pre")!.textContent).toContain('"hello": "world"'));
  });

  it("falls back to the event type when a message has no summary", async () => {
    current = thread({ waiting: [msg("w1", { summary: null, type: "com.linear.issue" })] });
    render(<Thread botId="b1" id="t1" />);
    expect(await screen.findByText("com.linear.issue")).toBeTruthy();
  });

  it("puts waiting first, then delivered runs newest first", async () => {
    current = thread({
      waiting: [msg("w1")],
      delivered: 3,
      delivered_messages: [
        delivered("a", "2026-10-12T08:00:00Z"),
        delivered("b", "2026-10-12T08:00:00Z"),
        delivered("c", "2026-10-12T09:00:00Z"),
      ],
    });
    render(<Thread botId="b1" id="t1" />);
    await screen.findByText("Run 2");
    const labels = [...document.querySelectorAll(".thread-group > .lbl")].map((l) => l.textContent?.split(/\d/)[0]);
    expect(labels.map((l) => l?.trim())).toEqual(["Waiting", "Run", "Run"]);
    const lines = [...document.querySelectorAll("details.message summary > div > div:first-child")].map(
      (d) => d.textContent,
    );
    expect(lines).toEqual([
      "mcwhittemore commented on #156: w1",
      "alice opened issue #1: c",
      "alice opened issue #1: a",
      "alice opened issue #1: b",
    ]);
    expect(screen.getByLabelText("Thread details").textContent).toContain("Messages4");
  });

  it("handles a thread with no title", async () => {
    current = thread({ title: null });
    render(<Thread botId="b1" id="t1" />);
    expect(await screen.findByRole("heading", { name: "Thread" })).toBeTruthy();
    expect(await screen.findAllByText(/^acme\/app#/)).toHaveLength(2);
  });

  it("disables Release while the runner is online", async () => {
    render(<Thread botId="b1" id="t1" />);
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Release" });
    await waitFor(() => expect(screen.getByLabelText("Thread details").textContent).toContain("online"));
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Its runner is online");
  });

  it("releases the thread while the runner is offline", async () => {
    online = false;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Thread botId="b1" id="t1" />);
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Release" });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(requests).toContain("POST /bots/b1/threads/t1/release"));
    await waitFor(() => expect(screen.getByLabelText("Thread details").textContent).toContain("none yet"));
  });

  it("ends the thread after confirming, even with its runner online", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Thread botId="b1" id="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "End thread" }));
    await waitFor(() => expect(requests).toContain("POST /bots/b1/threads/t1/end"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "End thread" })).toBeNull());
    expect(screen.getByText("ended")).toBeTruthy();
  });

  it("doesn't end the thread when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Thread botId="b1" id="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "End thread" }));
    expect(requests.some((r) => r.endsWith("/end"))).toBe(false);
  });

  it("shows the error when ending fails", async () => {
    endFails = true;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Thread botId="b1" id="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "End thread" }));
    expect(await screen.findByText("boom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "End thread" })).toBeTruthy();
  });

  it("offers no End thread on an ended thread", async () => {
    current = thread({ status: "ended" });
    render(<Thread botId="b1" id="t1" />);
    await screen.findByRole("button", { name: "Release" });
    expect(screen.queryByRole("button", { name: "End thread" })).toBeNull();
  });
});
