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
let botList: object[];
let requests: string[];
let runnerLeased: string | null;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string) => {
      const path = apiPath.replace(/^\/api/, "");
      requests.push(path);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      const [p = "", query = ""] = path.split("?");
      if (p === "/me") return json({ id: "u1", email: null, name: "Me" });
      if (p === "/bots") return json({ data: botList });
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
      if (/^\/bots\/b\d+\/threads$/.test(p)) return json({ data: [] });
      return new Response("{}", { status: 404 });
    }),
  );
}

function at(search: string) {
  window.history.replaceState(null, "", "/acme/bots/b1" + search);
}

beforeEach(() => {
  localStorage.setItem("loopway_token", "t");
  threads = [thread()];
  botList = [bot, { ...bot, id: "b2", name: "other" }];
  requests = [];
  runnerLeased = "2026-10-13T00:00:00Z";
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("helpers", () => {
  it("reads the tab, defaulting to activity", () => {
    window.history.replaceState(null, "", "/acme/bots/b1");
    expect(tabOf(null)).toBe("activity");
    expect(tabOf("nope")).toBe("activity");
    expect(tabOf("threads")).toBe("threads");
    expect(tabPath("b 1", "activity")).toBe("/acme/bots/b%201");
    expect(tabPath("b1", "settings")).toBe("/acme/bots/b1?tab=settings");
  });

  it("words a wait", () => {
    expect(waitText(null)).toBe("–");
    expect(waitText(30)).toBe("30 s");
    expect(waitText(125)).toBe("2 min");
    expect(waitText(3900)).toBe("1 h 5 min");
  });
});

describe("Bot page", () => {
  it("shows the header and tabs", async () => {
    at("");
    render(<Bot id="b1" />);
    expect((await screen.findAllByText("dev")).length).toBeGreaterThan(0);
    const tabs = within("Bot sections");
    expect(tabs.map((a) => a.textContent)).toEqual(["Activity", "Threads", "Prompt and rules · v3", "Settings"]);
    expect(tabs[0]!.getAttribute("href")).toBe("/acme/bots/b1");
    expect(tabs[1]!.getAttribute("href")).toBe("/acme/bots/b1?tab=threads");
    expect(tabs[2]!.getAttribute("href")).toBe("/acme/bots/b1/prompt");
  });

  it("keeps the tab when switching bots", async () => {
    at("?tab=threads");
    render(<Bot id="b1" />);
    await screen.findByText("Thread");
    fireEvent.click(await screen.findByRole("button", { name: /Switch bot/ }));
    expect(items().map((a) => a.getAttribute("href"))).toEqual([
      "/acme/bots",
      "/acme/bots/b1?tab=threads",
      "/acme/bots/b2?tab=threads",
    ]);
  });

  describe("switcher", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...bot, id: "b" + (i + 1), name: "bot " + (i + 1) }));
    const otherThreadRequests = () =>
      requests.filter((r) => /^\/bots\/b\d+\/threads/.test(r) && !r.startsWith("/bots/b1/"));
    const opener = () => screen.findByRole("button", { name: /Switch bot/ });

    it("is closed with the current bot's mark and makes no per-bot requests", async () => {
      at("");
      render(<Bot id="b1" />);
      const button = await opener();
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.textContent).toContain("dev");
      await waitFor(() => expect(button.querySelector(".dot.state-waiting")).toBeTruthy());
      expect(screen.queryByRole("menu")).toBeNull();
      expect(otherThreadRequests()).toEqual([]);
    });

    it("opens with every bot, marks and All bots, fetching the others then", async () => {
      at("");
      render(<Bot id="b1" />);
      fireEvent.click(await opener());
      expect(screen.getByRole("menu", { name: "Bots" })).toBeTruthy();
      expect(items().map((a) => a.textContent)).toEqual(["All bots", "dev", "other"]);
      expect(items()[1]!.getAttribute("aria-current")).toBe("page");
      expect(items()[2]!.getAttribute("aria-current")).toBeNull();
      await waitFor(() => expect(otherThreadRequests()).toEqual(["/bots/b2/threads?status=active"]));
      await waitFor(() => expect(items()[2]!.querySelector(".dot[title]")).toBeTruthy());
      expect(screen.queryByRole("searchbox")).toBeNull();
    });

    it("closes on Escape and returns focus, and on an outside click", async () => {
      at("");
      render(<Bot id="b1" />);
      const button = await opener();
      fireEvent.click(button);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("moves with the arrow keys", async () => {
      at("");
      render(<Bot id="b1" />);
      fireEvent.click(await opener());
      expect(document.activeElement).toBe(items()[1]);
      fireEvent.keyDown(items()[1]!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(items()[2]);
      fireEvent.keyDown(items()[2]!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(items()[0]);
      fireEvent.keyDown(items()[0]!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(items()[2]);
    });

    it("filters with a find box when there are many bots", async () => {
      botList = many(30);
      at("");
      render(<Bot id="b1" />);
      fireEvent.click(await opener());
      expect(items()).toHaveLength(31);
      const find = screen.getByRole("searchbox", { name: "Find a bot" });
      expect(document.activeElement).toBe(find);
      fireEvent.change(find, { target: { value: "bot 2" } });
      expect(items().map((a) => a.textContent)).toEqual([
        "All bots",
        "bot 2",
        ...Array.from({ length: 10 }, (_, i) => "bot 2" + i),
      ]);
      fireEvent.change(find, { target: { value: "zzz" } });
      expect(screen.getByText("No bot matches.")).toBeTruthy();
      fireEvent.change(find, { target: { value: "bot 7" } });
      fireEvent.keyDown(find, { key: "ArrowDown" });
      expect(document.activeElement).toBe(items()[0]);
      const fetched = otherThreadRequests().length;
      fireEvent.change(find, { target: { value: "" } });
      expect(items()).toHaveLength(31);
      expect(otherThreadRequests()).toHaveLength(fetched);
    });

    it("closes on Tab", async () => {
      at("");
      render(<Bot id="b1" />);
      fireEvent.click(await opener());
      fireEvent.keyDown(items()[1]!, { key: "Tab" });
      expect(screen.queryByRole("menu")).toBeNull();
    });
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
    await waitFor(() => expect(screen.getAllByRole("img", { name: /^(?!Loopway)/ })).toHaveLength(30));
    expect(screen.getAllByRole("img", { name: /^(?!Loopway)/ })[29]!.getAttribute("aria-label")).toBe(
      "Sep 30 · 5 delivered",
    );
    expect(screen.getByText("max 5")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/^Version \d$/)).toHaveLength(3));
    expect(screen.getByText("Delivered today").nextElementSibling!.textContent).toBe("5");
  });

  it("threads tab lists open threads and filters", async () => {
    at("?tab=threads");
    render(<Bot id="b1" />);
    const link = await screen.findByText("acme/app#7");
    expect(link.getAttribute("href")).toBe("/acme/bots/b1/threads/t1");
    fireEvent.click(screen.getByText("Ended"));
    await screen.findByText("acme/app#1");
    expect(screen.queryByText("acme/app#7")).toBeNull();
  });

  it("settings tab has the edit form and the versions editor", async () => {
    at("?tab=settings");
    render(<Bot id="b1" />);
    expect((await screen.findByLabelText<HTMLInputElement>("Name")).value).toBe("dev");
    expect(screen.getByLabelText<HTMLSelectElement>("Model").value).toBe("sonnet");
    expect(screen.getByText("Delete bot")).toBeTruthy();
    expect(screen.queryByText("Save as new version")).toBeNull();
  });
});

function within(label: string) {
  return Array.from(screen.getByRole("navigation", { name: label }).querySelectorAll("a"));
}

const items = () => screen.getAllByRole("menuitem");
