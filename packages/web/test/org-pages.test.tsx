// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgsContext } from "../client/layout.js";
import * as lw from "../client/lw.js";
import { track } from "../client/metrics.js";
import { DashboardRedirect, OrgGate } from "../client/org-pages.js";
import { OrgSwitcher } from "../client/org-switcher.js";

vi.mock("../client/metrics.js", () => ({ track: vi.fn(), identify: vi.fn(), reset: vi.fn() }));

const mine = { id: "o1", slug: "mcwhittemore", name: "mcwhittemore", personal: true };
const team = { id: "o2", slug: "craftmill", name: "craftmill", personal: false };

const online = {
  id: "r1",
  org: "craftmill",
  name: "laptop",
  leased_until: "2099-01-01T00:00:00Z",
  bots: [],
  threads: 0,
};
const offline = { id: "r0", org: "craftmill", name: "old", leased_until: null, bots: [], threads: 0 };

let replaced: string[];
let requests: string[];
let bots: object[] | null;
let runners: object[];
let activity: object[];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("loopway_token", "t");
  replaced = [];
  requests = [];
  bots = [{ id: "b1" }];
  runners = [online];
  activity = [{ bot_id: "b1", last_delivery_at: "2026-10-18T00:00:00Z" }];
  // A stand-in for location that reads the real one (history.replaceState moves it) and records replace().
  const real = window.location;
  vi.stubGlobal("location", {
    origin: real.origin,
    get pathname() {
      return real.pathname;
    },
    get search() {
      return real.search;
    },
    get hash() {
      return real.hash;
    },
    replace: (to: string) => replaced.push(to),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string) => {
      const path = apiPath.replace(/^\/api/, "");
      requests.push(path);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path.startsWith("/bots?org=")) return bots ? json({ data: bots }) : new Response("{}", { status: 500 });
      if (path.startsWith("/runners?org=")) return json({ data: runners });
      if (path.startsWith("/bots/activity?")) return json({ data: activity });
      if (path === "/orgs") return json({ data: [mine, team] });
      if (path === "/bots/b1") return json({ id: "b1", org_id: "o2" });
      if (path === "/inboxes/i1") return json({ id: "i1", org_id: "o1" });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OrgGate", () => {
  it("shows the page of an org the user is in, and remembers it", async () => {
    window.history.replaceState(null, "", "/craftmill/bots");
    render(<OrgGate>the page</OrgGate>);
    expect(await screen.findByText("the page")).toBeTruthy();
    // OrgGate remembers the org in a passive effect, which can run after the page has appeared.
    await waitFor(() => expect(localStorage.getItem("loopway_last_org")).toBe("craftmill"));
  });

  it("shows the same not-found page for an org that doesn't exist and one the user isn't in", async () => {
    const texts: string[] = [];
    for (const path of ["/someone-elses", "/no-such-org"]) {
      window.history.replaceState(null, "", path);
      const { container, unmount } = render(<OrgGate>the page</OrgGate>);
      await screen.findByText("Page not found");
      expect(screen.queryByText("the page")).toBeNull();
      texts.push(container.textContent ?? "");
      unmount();
    }
    expect(texts[0]).toBe(texts[1]);
    expect(localStorage.getItem("loopway_last_org")).toBeNull();
    expect(track).toHaveBeenCalledWith("org_page_not_found");
  });
});

describe("OrgGate with no bots", () => {
  beforeEach(() => {
    bots = [];
    runners = [];
    activity = [];
  });

  it("shows only the zero state, with copyable steps and no nav", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    window.history.replaceState(null, "", "/craftmill");
    render(<OrgGate>the page</OrgGate>);
    expect(await screen.findByText(/Get your runner going/)).toBeTruthy();
    expect(screen.queryByText("the page")).toBeNull();
    expect(screen.queryByText("Bots")).toBeNull();
    expect(screen.queryByText("New bot")).toBeNull();
    expect(screen.getByText("Members")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Copy")[0]!);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("curl -fsSL https://loopway.craftmill.dev/install.sh | sh"),
    );
    expect(track).toHaveBeenCalledWith("zero_state_viewed");
    expect(track).toHaveBeenCalledWith("runners_command_copied", { command: "install", from: "zero_state" });
  });

  it("moves on to the connected state when a runner shows up, without a refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState(null, "", "/craftmill");
    render(<OrgGate>the page</OrgGate>);
    expect(await screen.findByText(/Get your runner going/)).toBeTruthy();
    expect(screen.queryByText("Your runner is connected")).toBeNull();
    runners = [offline];
    await act(() => vi.advanceTimersByTimeAsync(lw.POLL_MS + 1000));
    expect(screen.queryByText("Your runner is connected")).toBeNull();
    runners = [online];
    await act(() => vi.advanceTimersByTimeAsync(lw.POLL_MS + 1000));
    expect(await screen.findByText("Your runner is connected")).toBeTruthy();
    expect(screen.queryByText(/Get your runner going/)).toBeNull();
    expect(screen.queryByText("New bot")).toBeNull();
    expect(screen.getByLabelText("Create your bot with your agent").textContent).toContain('--org craftmill');
    expect(track).toHaveBeenCalledWith("zero_state_runner_connected");
  });

  it("walks the three steps live and ends the zero state at the third", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState(null, "", "/craftmill");
    render(<OrgGate>the page</OrgGate>);
    await screen.findByText(/Get your runner going/);
    const steps = () => screen.getAllByRole("listitem").map((li) => li.getAttribute("aria-current") === "step");
    expect(screen.getByText("Get loopway running")).toBeTruthy();
    expect(screen.getByText("Make your first bot")).toBeTruthy();
    expect(screen.getByText("See it run")).toBeTruthy();
    expect(steps()).toEqual([true, false, false]);
    runners = [online];
    await act(() => vi.advanceTimersByTimeAsync(lw.POLL_MS + 1000));
    expect(steps()).toEqual([false, true, false]);
    bots = [{ id: "b1" }];
    await act(() => vi.advanceTimersByTimeAsync(lw.POLL_MS + 1000));
    expect(steps()).toEqual([false, false, true]);
    expect(screen.getByText("Your bot is ready")).toBeTruthy();
    expect(screen.queryByText("the page")).toBeNull();
    activity = [{ bot_id: "b1", last_delivery_at: "2026-10-18T00:00:00Z" }];
    await act(() => vi.advanceTimersByTimeAsync(lw.POLL_MS + 1000));
    expect(await screen.findByText("the page")).toBeTruthy();
    for (const e of ["runner_connected", "bot_created", "first_run", "completed"])
      expect(track).toHaveBeenCalledWith("zero_state_" + e);
  });

  it("leaves the members page alone", async () => {
    window.history.replaceState(null, "", "/craftmill/members");
    render(<OrgGate>the members</OrgGate>);
    expect(await screen.findByText("the members")).toBeTruthy();
  });
});

describe("OrgGate for each combination of setup steps", () => {
  const cases: [string, boolean, boolean, boolean][] = [
    ["nothing done", false, false, false],
    ["only a runner", true, false, false],
    ["only a bot", false, true, false],
    ["a runner and a bot that never ran", true, true, false],
    ["everything done", true, true, true],
  ];
  it.each(cases)("%s", async (_name, runner, bot, ran) => {
    runners = runner ? [online] : [offline];
    bots = bot ? [{ id: "b1" }] : [];
    activity = ran ? [{ bot_id: "b1", last_delivery_at: "2026-10-18T00:00:00Z" }] : [];
    window.history.replaceState(null, "", "/craftmill");
    render(<OrgGate>the page</OrgGate>);
    if (runner && bot && ran) {
      expect(await screen.findByText("the page")).toBeTruthy();
      expect(track).not.toHaveBeenCalledWith("zero_state_viewed");
      return;
    }
    await screen.findByText("Get loopway running");
    expect(screen.queryByText("the page")).toBeNull();
    const current = screen.getAllByRole("listitem").findIndex((li) => li.getAttribute("aria-current") === "step");
    expect(current).toBe(!runner ? 0 : !bot ? 1 : 2);
  });
});

describe("OrgGate for an established org whose runner is offline", () => {
  it("shows the normal page", async () => {
    runners = [offline];
    window.history.replaceState(null, "", "/craftmill");
    render(<OrgGate>the page</OrgGate>);
    expect(await screen.findByText("the page")).toBeTruthy();
    expect(track).not.toHaveBeenCalledWith("zero_state_viewed");
  });
});

describe("OrgGate when the bots request fails", () => {
  it("shows the normal page", async () => {
    bots = null;
    window.history.replaceState(null, "", "/craftmill");
    render(<OrgGate>the page</OrgGate>);
    expect(await screen.findByText("the page")).toBeTruthy();
  });
});

describe("OrgGate with a bot", () => {
  it("shows the normal page", async () => {
    window.history.replaceState(null, "", "/craftmill");
    render(<OrgGate>the page</OrgGate>);
    expect(await screen.findByText("the page")).toBeTruthy();
    expect(track).not.toHaveBeenCalledWith("zero_state_viewed");
  });
});

describe("DashboardRedirect", () => {
  it("sends an overview or list page to the last-used org", async () => {
    window.history.replaceState(null, "", "/dashboard/bots");
    localStorage.setItem("loopway_last_org", "craftmill");
    render(<DashboardRedirect rest="/bots" />);
    await waitFor(() => expect(replaced).toEqual(["/craftmill/bots"]));
  });

  it("falls back to the personal org", async () => {
    window.history.replaceState(null, "", "/dashboard");
    localStorage.setItem("loopway_last_org", "left-this-org");
    render(<DashboardRedirect rest="" />);
    await waitFor(() => expect(replaced).toEqual(["/mcwhittemore"]));
  });

  it("sends a bot or inbox to the org that owns it, keeping the rest of the address", async () => {
    window.history.replaceState(null, "", "/dashboard/bots/b1/threads/t1?x=1");
    render(<DashboardRedirect rest="/bots/b1/threads/t1" />);
    await waitFor(() => expect(replaced).toEqual(["/craftmill/bots/b1/threads/t1?x=1"]));
    cleanup();
    replaced = [];
    window.history.replaceState(null, "", "/dashboard/inboxes/i1");
    localStorage.setItem("loopway_last_org", "craftmill");
    render(<DashboardRedirect rest="/inboxes/i1" />);
    await waitFor(() => expect(replaced).toEqual(["/mcwhittemore/inboxes/i1"]));
  });

  it("uses the last-used org when the bot can't be found", async () => {
    window.history.replaceState(null, "", "/dashboard/bots/gone");
    render(<DashboardRedirect rest="/bots/gone" />);
    await waitFor(() => expect(replaced).toEqual(["/mcwhittemore/bots/gone"]));
  });
});

describe("OrgSwitcher", () => {
  it("lists the orgs with the personal one first and marks the current one", () => {
    render(
      <OrgsContext.Provider value={[mine, team]}>
        <OrgSwitcher orgs={[mine, team]} current="craftmill" />
      </OrgsContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Org: craftmill/ }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((a) => a.textContent)).toEqual(["mcwhittemore (you)", "craftmill", "+ New org"]);
    expect(items.map((a) => a.getAttribute("href"))).toEqual(["/mcwhittemore", "/craftmill", "/orgs/new"]);
    expect(items.map((a) => a.getAttribute("aria-current"))).toEqual([null, "page", null]);
    fireEvent.click(items[0]!);
    expect(track).toHaveBeenCalledWith("org_switched", { to_personal: true, same: false });
    fireEvent.click(items[2]!);
    expect(track).toHaveBeenCalledWith("org_new_clicked");
  });
});

describe("login return path", () => {
  it("remembers the page and only returns to paths on this site", () => {
    window.history.replaceState(null, "", "/craftmill/bots?tab=x");
    expect(lw.loginUrl()).toBe("/login?next=" + encodeURIComponent("/craftmill/bots?tab=x"));
    window.history.replaceState(null, "", "/login?next=" + encodeURIComponent("/craftmill/bots"));
    expect(lw.nextPath()).toBe("/craftmill/bots");
    for (const bad of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
    ]) {
      window.history.replaceState(null, "", "/login?next=" + encodeURIComponent(bad));
      expect(lw.nextPath(), bad).toBeNull();
    }
  });
});
