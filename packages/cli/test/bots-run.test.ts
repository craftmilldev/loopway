import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../src/context.js";

const mocks = vi.hoisted(() => ({
  showTui: vi.fn<(props: unknown, signal?: AbortSignal) => Promise<void>>(async () => {}),
  start: vi.fn(),
}));

vi.mock("../src/bots/tui.js", () => ({ showTui: mocks.showTui }));
vi.mock("../src/bots/dispatcher.js", async (orig) => ({
  ...(await orig<typeof import("../src/bots/dispatcher.js")>()),
  Dispatcher: { start: mocks.start },
}));
vi.mock("../src/bots/runner.js", () => ({
  ensureRunner: async () => ({ id: "r1", org_id: "o1", org: "acme" }),
  savedRunnerOrg: async () => undefined,
}));
vi.mock("../src/update.js", () => ({
  availableUpdate: async () => undefined,
  applyUpdate: async () => {},
  whyNoUpdate: async () => undefined,
  outdatedNotice: () => "",
  minimumFrom: () => undefined,
}));
vi.mock("../src/context.js", async (orig) => ({
  ...(await orig<typeof import("../src/context.js")>()),
  authedClient: async () => ({ listBots: async () => [] }),
}));

import { runBots } from "../src/commands/bots-run.js";

/** A dispatcher that is always idle; the poll loop sleeps on its timer and never finishes. */
const dispatcher = () => ({
  tick: async () => {},
  close: async () => {},
  drain: () => {},
  takeOutdated: () => false,
  busy: false,
  idleMs: () => 0,
  slotFreed: () => new Promise<void>(() => {}),
  state: async () => ({}),
  refresh: async () => {},
});

describe("bots run with no bots", () => {
  const out: string[] = [];
  const ctx = (interactive: boolean, manager: boolean): Context => ({
    configDir: "/nonexistent-loopway-config",
    env: { LOOPWAY_MANAGER: manager ? "1" : "0", LOOPWAY_NO_UPDATE: "1" },
    interactive,
    out: (t) => void out.push(t),
  });

  beforeEach(() => {
    out.length = 0;
    mocks.showTui.mockClear();
    mocks.start.mockReset().mockImplementation(async () => dispatcher());
    // The exit handlers and the final interrupt are the real process's, not the test's.
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "kill").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens the TUI in Chat when the manager is on in a terminal", async () => {
    await runBots(ctx(true, true), { org: "acme" });
    expect(out.join("\n")).not.toContain("No bots to run");
    // The dispatcher starts with an empty bot list.
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start.mock.calls[0]![2]).toEqual([]);
    expect(mocks.showTui).toHaveBeenCalledOnce();
    expect(mocks.showTui.mock.calls[0]![0]).toMatchObject({
      chat: expect.objectContaining({ botId: "manager:acme" }),
      startInChat: true,
    });
  });

  it.each([
    ["the manager is off", ctx(true, false), {}],
    ["--no-tui is given", ctx(true, true), { tui: false }],
    ["there is no terminal", ctx(false, true), {}],
  ])("still says how to create a bot and exits when %s", async (_name, c, opts) => {
    await runBots(c, { org: "acme", ...opts });
    expect(out.join("\n")).toMatch(/No bots to run.*loopway bots create/);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.showTui).not.toHaveBeenCalled();
  });
});
