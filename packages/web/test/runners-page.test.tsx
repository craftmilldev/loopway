// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Runners } from "../client/runners.js";

const soon = new Date(Date.now() + 60_000).toISOString();
const runner = (over: object = {}) => ({
  id: "r1",
  org: "acme",
  name: "laptop",
  last_seen_at: new Date().toISOString(),
  leased_until: soon,
  bots: [{ id: "b1", name: "dev" }],
  threads: 2,
  ...over,
});
const online = runner();
const offline = runner({
  id: "r2",
  name: "old-box",
  leased_until: null,
  bots: [{ id: "b2", name: "reviewer" }],
  threads: 1,
});
const idle = runner({ id: "r3", name: "spare", bots: [], threads: 0 });

let runners: object[];
let writeText: ReturnType<typeof vi.fn>;
const thread = (runner_id: string) => ({
  id: "t",
  status: "active",
  runner_id,
  limited: null,
  inflight: [],
  waiting: [],
});

beforeEach(() => {
  window.history.replaceState(null, "", "/acme/runners");
  localStorage.setItem("loopway_token", "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string) => {
      const path = apiPath.replace(/^\/api/, "");
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      const [p = ""] = path.split("?");
      if (p === "/me") return json({ id: "u1", email: null, name: "Me" });
      if (p === "/orgs") return json({ data: [{ id: "o1", slug: "acme", personal: false }] });
      if (p.endsWith("/runners")) return json({ data: runners });
      if (p === "/bots/b2/threads") return json({ data: [thread("r2")] });
      return json({ data: [] });
    }),
  );
  writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Runners page", () => {
  it("shows the empty state with copyable commands", async () => {
    runners = [];
    render(<Runners />);
    expect(await screen.findByText("No runners yet.")).toBeTruthy();
    expect(screen.getByText(/Nothing is running your bots/)).toBeTruthy();
    fireEvent.click(screen.getAllByText("Copy")[2]!);
    expect(writeText).toHaveBeenCalledWith("cd ~/code/your-repo && loopway bots run");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists online and offline runners with bots, threads and the stranded note", async () => {
    runners = [online, offline];
    render(<Runners />);
    const row = (await screen.findByText("old-box")).closest("tr")!;
    expect(screen.getByText("1 of 2 runners online.")).toBeTruthy();
    expect(within(row).getByText("offline")).toBeTruthy();
    expect(within(row).getByText(/stranded\. Restart the runner/)).toBeTruthy();
    expect(within(row).getByText("reviewer").getAttribute("href")).toBe("/acme/bots/b2");
    await waitFor(() => expect(within(row).getByText("stranded", { selector: ".state" })).toBeTruthy());
    const live = screen.getByText("laptop").closest("tr")!;
    expect(within(live).getByText("online")).toBeTruthy();
    expect(within(live).queryByText(/stranded\. Restart/)).toBeNull();
    expect(within(live).getByText("dev").getAttribute("href")).toBe("/acme/bots/b1");
  });

  it("does not flag an offline runner that owns no threads", async () => {
    runners = [runner({ id: "r4", name: "quiet", leased_until: null, threads: 0, bots: [] })];
    render(<Runners />);
    await screen.findByText("quiet");
    expect(screen.queryByText(/Restart the runner/)).toBeNull();
  });

  it("counts the filters and combines them with find", async () => {
    runners = [online, offline, idle];
    render(<Runners />);
    await screen.findByText("old-box");
    expect(screen.getByText("All · 3")).toBeTruthy();
    expect(screen.getByText("Online · 2")).toBeTruthy();
    expect(screen.getByText("Offline · 1")).toBeTruthy();

    fireEvent.click(screen.getByText("Online · 2"));
    expect(screen.queryByText("old-box")).toBeNull();
    expect(screen.getByText("laptop")).toBeTruthy();

    // Find reaches bot names too, and only within the chosen state.
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "REVIEWER" } });
    expect(screen.getByText("No runners match.")).toBeTruthy();
    fireEvent.click(screen.getByText("All · 3"));
    expect(screen.getByText("old-box")).toBeTruthy();
    expect(screen.queryByText("laptop")).toBeNull();
  });
});
