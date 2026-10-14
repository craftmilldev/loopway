// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgsContext } from "../client/layout.js";
import * as lw from "../client/lw.js";
import { track } from "../client/metrics.js";
import { DashboardRedirect, OrgGate } from "../client/org-pages.js";
import { OrgSwitcher } from "../client/org-switcher.js";

vi.mock("../client/metrics.js", () => ({ track: vi.fn(), identify: vi.fn(), reset: vi.fn() }));

const mine = { id: "o1", slug: "mcwhittemore", name: "mcwhittemore", personal: true };
const team = { id: "o2", slug: "craftmill", name: "craftmill", personal: false };

let replaced: string[];
let requests: string[];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("loopway_token", "t");
  replaced = [];
  requests = [];
  // A stand-in for location that reads the real one (history.replaceState moves it) and records replace().
  const real = window.location;
  vi.stubGlobal("location", {
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
      if (path === "/orgs") return json({ data: [mine, team] });
      if (path === "/bots/b1") return json({ id: "b1", org_id: "o2" });
      if (path === "/inboxes/i1") return json({ id: "i1", org_id: "o1" });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OrgGate", () => {
  it("shows the page of an org the user is in, and remembers it", async () => {
    window.history.replaceState(null, "", "/craftmill/bots");
    render(<OrgGate>the page</OrgGate>);
    expect(await screen.findByText("the page")).toBeTruthy();
    expect(localStorage.getItem("loopway_last_org")).toBe("craftmill");
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
    expect(items.map((a) => a.textContent)).toEqual(["mcwhittemore (you)", "craftmill"]);
    expect(items.map((a) => a.getAttribute("href"))).toEqual(["/mcwhittemore", "/craftmill"]);
    expect(items.map((a) => a.getAttribute("aria-current"))).toEqual([null, "page"]);
    fireEvent.click(items[0]!);
    expect(track).toHaveBeenCalledWith("org_switched", { to_personal: true, same: false });
  });
});

describe("login return path", () => {
  it("remembers the page and only returns to paths on this site", () => {
    window.history.replaceState(null, "", "/craftmill/bots?tab=x");
    expect(lw.loginUrl()).toBe("/login?next=" + encodeURIComponent("/craftmill/bots?tab=x"));
    window.history.replaceState(null, "", "/login?next=" + encodeURIComponent("/craftmill/bots"));
    expect(lw.nextPath()).toBe("/craftmill/bots");
    for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example"]) {
      window.history.replaceState(null, "", "/login?next=" + encodeURIComponent(bad));
      expect(lw.nextPath(), bad).toBeNull();
    }
  });
});
