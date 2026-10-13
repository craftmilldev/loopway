// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bot, tabOf, tabPath, waitText } from "../client/bot.js";

const bot = {
  id: "b1",
  name: "dev",
  model: "sonnet",
  prompt_version: { version: 3, prompt: "p", rules: null, created_at: "2026-10-01T00:00:00Z" },
  inbox_ids: ["i1"],
  cursor: 12,
  runner_id: "r1",
  leased_until: null,
};
const thread = (over: object = {}) => ({
  id: "t1",
  bot_id: "b1",
  status: "active",
  started: true,
  interrupted: false,
  limited: false,
  runner_id: "r1",
  subjects: ["acme/app#7"],
  waiting: [{ id: "m1", inbox_id: "i1", type: "x", subject: null }],
  inflight: [],
  delivered: 4,
  updated_at: "2026-10-12T00:00:00Z",
  ...over,
});
const days = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    delivered: i === n - 1 ? 5 : 1,
  }));
const activity = (n: number) => ({
  bot_id: "b1",
  days: days(n),
  delivered: n + 4,
  last_delivery_at: null,
  runs: 3,
  median_wait_seconds: 125,
});

let threads: object[];
let runnerLeased: string | null;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      const [p = "", query = ""] = path.split("?");
      if (p === "/me") return json({ id: "u1", email: null, name: "Me" });
      if (p === "/bots") return json({ data: [bot, { ...bot, id: "b2", name: "other" }] });
      if (p === "/bots/b1") return json(bot);
      if (p === "/runners")
        return json({
          data: [{ id: "r1", name: "laptop", last_seen_at: "", leased_until: runnerLeased, bots: [], threads: 1 }],
        });
      if (p === "/inboxes") return json({ data: [{ id: "i1", name: "github" }] });
      if (p.endsWith("/threads")) {
        const status = new URLSearchParams(query).get("status");
        return json({
          data: status === "ended" ? [thread({ id: "t2", status: "ended", subjects: ["acme/app#1"] })] : threads,
        });
      }
      if (p === "/bots/b1/activity") return json(activity(query.includes("days=7") ? 7 : 30));
      if (p === "/bots/b1/versions")
        return json({ data: [3, 2, 1].map((v) => ({ ...bot.prompt_version, version: v })) });
      if (p === "/bots/b2/threads") return json({ data: [] });
      return new Response("{}", { status: 404 });
    }),
  );
}

function at(search: string) {
  window.history.replaceState(null, "", "/dashboard/bots/b1" + search);
}

beforeEach(() => {
  localStorage.setItem("loopway_token", "t");
  threads = [thread()];
  runnerLeased = "2026-10-13T00:00:00Z";
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("helpers", () => {
  it("reads the tab, defaulting to activity", () => {
    expect(tabOf(null)).toBe("activity");
    expect(tabOf("nope")).toBe("activity");
    expect(tabOf("threads")).toBe("threads");
    expect(tabPath("b 1", "activity")).toBe("/dashboard/bots/b%201");
    expect(tabPath("b1", "settings")).toBe("/dashboard/bots/b1?tab=settings");
  });

  it("words a wait", () => {
    expect(waitText(null)).toBe("–");
    expect(waitText(30)).toBe("30 s");
    expect(waitText(125)).toBe("2 min");
    expect(waitText(3900)).toBe("1 h 5 min");
  });
});

describe("Bot page", () => {
  it("shows the header, tabs and switcher", async () => {
    at("");
    render(<Bot id="b1" />);
    expect((await screen.findAllByText("dev")).length).toBeGreaterThan(0);
    const tabs = within("Bot sections");
    expect(tabs.map((a) => a.textContent)).toEqual(["Activity", "Threads", "Prompt and rules · v3", "Settings"]);
    expect(tabs[0]!.getAttribute("href")).toBe("/dashboard/bots/b1");
    expect(tabs[1]!.getAttribute("href")).toBe("/dashboard/bots/b1?tab=threads");
    expect(tabs[2]!.getAttribute("href")).toBe("/dashboard/bots/b1/prompt");
    const switcher = within("Bots");
    expect(switcher.map((a) => a.textContent)).toEqual(["All bots", "dev", "other"]);
    expect(switcher[2]!.getAttribute("href")).toBe("/dashboard/bots/b2");
  });

  it("keeps the tab when switching bots", async () => {
    at("?tab=threads");
    render(<Bot id="b1" />);
    await screen.findByText("Subjects");
    expect(within("Bots")[2]!.getAttribute("href")).toBe("/dashboard/bots/b2?tab=threads");
  });

  it("shows no banner for a working bot", async () => {
    at("");
    render(<Bot id="b1" />);
    await screen.findByText("Right now");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a banner when stranded", async () => {
    runnerLeased = null;
    at("");
    render(<Bot id="b1" />);
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Stranded");
    expect(banner.textContent).toContain("1 message waiting");
  });

  it("shows a banner when limited", async () => {
    threads = [thread({ limited: true })];
    at("");
    render(<Bot id="b1" />);
    expect((await screen.findByRole("alert")).textContent).toContain("usage limit");
  });

  it("activity tab shows figures, bars and the side column", async () => {
    at("");
    render(<Bot id="b1" />);
    await screen.findByText("Right now");
    await waitFor(() => expect(screen.getByText("in 3 runs")).toBeTruthy());
    expect(screen.getByText("11")).toBeTruthy();
    expect(screen.getByText("2 min")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(30));
    expect(screen.getAllByRole("img")[29]!.getAttribute("aria-label")).toBe("Sep 30 · 5 delivered");
    expect(screen.getByText("max 5")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/^Version \d$/)).toHaveLength(3));
    expect(screen.getByText("Delivered today").nextElementSibling!.textContent).toBe("5");
  });

  it("threads tab lists open threads and filters", async () => {
    at("?tab=threads");
    render(<Bot id="b1" />);
    const link = await screen.findByText("acme/app#7");
    expect(link.getAttribute("href")).toBe("/dashboard/bots/b1/threads/t1");
    fireEvent.click(screen.getByText("Ended"));
    await screen.findByText("acme/app#1");
    expect(screen.queryByText("acme/app#7")).toBeNull();
  });

  it("settings tab has the edit form and the versions editor", async () => {
    at("?tab=settings");
    render(<Bot id="b1" />);
    expect(((await screen.findByLabelText("Name")) as HTMLInputElement).value).toBe("dev");
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("sonnet");
    expect(screen.getByText("Delete bot")).toBeTruthy();
    expect(screen.getByText("Save as new version")).toBeTruthy();
  });
});

function within(label: string) {
  return Array.from(screen.getByRole("navigation", { name: label }).querySelectorAll("a"));
}
