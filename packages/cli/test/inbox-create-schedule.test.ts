import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  answers: [] as unknown[],
  createInbox: vi.fn(),
}));

vi.mock("@clack/prompts", () => {
  const next = async () => mocks.answers.shift();
  return {
    intro: () => {},
    outro: () => {},
    note: () => {},
    cancel: () => {},
    isCancel: (v: unknown) => typeof v === "symbol",
    log: { error: () => {} },
    spinner: () => ({ start: () => {}, stop: () => {}, error: () => {}, clear: () => {} }),
    text: next,
    select: next,
    confirm: next,
    password: next,
  };
});
vi.mock("../src/commands/orgs.js", () => ({ resolveOrg: async () => "me" }));
vi.mock("../src/context.js", async (orig) => ({
  ...(await orig<typeof import("../src/context.js")>()),
  authedClient: async () => ({
    sources: async () => [
      { type: "github", label: "GitHub", description: "", secret: { from: "generated" } },
      { type: "schedule", label: "Schedule", description: "", secret: { from: "none" } },
    ],
    createInbox: mocks.createInbox,
  }),
}));

import { createInbox } from "../src/commands/inboxes.js";
import type { Context } from "../src/context.js";

const events: [string, unknown][] = [];
const out: string[] = [];
const ctx = {
  configDir: "",
  env: {},
  interactive: true,
  out: (t: string) => out.push(t),
  metrics: { capture: async (e: string, props: unknown) => void events.push([e, props]) },
} as unknown as Context;

beforeEach(() => {
  mocks.answers = [];
  mocks.createInbox.mockReset();
  mocks.createInbox.mockImplementation(async (body) => ({
    id: "inb_1",
    name: body.name,
    ...body,
    config: body.config,
  }));
  events.length = 0;
});

describe("inbox create, interactive schedule", () => {
  it("offers Schedule, asks the schedule, then the messages, and creates it", async () => {
    // name, source, how often, hour, then the message loop: add -> type -> text -> save
    mocks.answers = ["clock", "schedule", "day", "7", "add", "standup", "Write the standup", "done"];
    await createInbox(ctx, {});
    expect(mocks.createInbox).toHaveBeenCalledWith({
      org: "me",
      name: "clock",
      source_type: "schedule",
      config: { schedule: { every: "day", hour: 7 }, messages: [{ type: "standup", message: "Write the standup" }] },
    });
    expect(events).toEqual([["schedule_created", { how: "interactive" }]]);
  });

  it("rejects saving with no messages before calling the server", async () => {
    mocks.answers = ["clock", "schedule", "hour", "done"];
    await expect(createInbox(ctx, {})).rejects.toThrow(/at least one message/);
    expect(mocks.createInbox).not.toHaveBeenCalled();
    expect(events).toEqual([["inbox_create_rejected", { source: "schedule", reason: "no_messages" }]]);
  });
});
