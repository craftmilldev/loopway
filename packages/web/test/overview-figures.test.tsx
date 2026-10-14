// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overview } from "../client/overview.js";

const msg = { id: "m", inbox_id: "i1", type: "x", subject: null };
const thread = (botId: string, id: string, inflight: number, waiting: number) => ({
  id,
  bot_id: botId,
  status: "active",
  started: true,
  interrupted: false,
  limited: false,
  runner_id: "r1",
  subjects: [],
  waiting: Array(waiting).fill(msg),
  inflight: Array(inflight).fill(msg),
  delivered: 0,
  updated_at: "2026-10-12T00:00:00Z",
});
const bot = (id: string) => ({ id, name: id, model: "sonnet", harness: "claude", inbox_ids: ["i1"], runner_id: "r1" });
const runner = {
  id: "r1",
  name: "box",
  leased_until: "2030-01-01T00:00:00Z",
  bots: [],
  threads: 0,
  org: "acme",
  last_seen_at: "2026-10-12T00:00:00Z",
};

// a: one working thread with 2 queued, one quiet thread with 1 queued. b: one quiet thread, nothing queued.
const threads: Record<string, object[]> = {
  a: [thread("a", "t1", 1, 2), thread("a", "t2", 0, 1)],
  b: [thread("b", "t3", 0, 0)],
};

beforeEach(() => {
  window.history.replaceState(null, "", "/acme");
  localStorage.setItem("loopway_token", "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string) => {
      const [p = ""] = apiPath.replace(/^\/api/, "").split("?");
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (p === "/me") return json({ id: "u1", email: null, name: "Me" });
      if (p === "/bots") return json({ data: [bot("a"), bot("b")] });
      if (p === "/runners") return json({ data: [runner] });
      if (p === "/inboxes") return json({ data: [{ id: "i1", name: "gh" }] });
      if (p === "/bots/activity") return json({ data: [] });
      const m = /^\/bots\/(\w+)\/threads$/.exec(p);
      if (m) return json({ data: threads[m[1]!] });
      return json({ data: [], next: null });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Overview figures", () => {
  it("agree with the bots table totals", async () => {
    render(<Overview />);
    const figures = within(await screen.findByLabelText("Figures"));
    const figure = (label: string) => figures.getByText(label).closest(".figure") as HTMLElement;
    const open = figure("Open threads");
    await waitFor(() => expect(within(open).getByText("3")).toBeTruthy());
    expect(open.textContent).toContain("1 working · 2 quiet");
    const waiting = figure("Messages waiting");
    expect(within(waiting).getByText("3")).toBeTruthy();

    const table = screen.getByRole("table");
    const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent);
    const column = (name: string) => {
      const i = heads.indexOf(name);
      return [...table.querySelectorAll("tbody tr")].map((tr) => Number(tr.children[i]!.textContent));
    };
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
    expect(sum(column("Open threads"))).toBe(3);
    expect(sum(column("Messages waiting"))).toBe(3);
  });
});
