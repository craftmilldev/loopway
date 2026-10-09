import { render } from "ink-testing-library";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Bot } from "../src/client.js";
import type { Session } from "../src/threads/store.js";
import { transcriptLines } from "../src/threads/transcript.js";
import { ThreadsTui, type Snapshot } from "../src/threads/tui.js";

const KEYS = { up: "\u001B[A", down: "\u001B[B", right: "\u001B[C", left: "\u001B[D", enter: "\r", tab: "\t" };

const session = (keys: string[], status: Session["status"], updated_at: string): Session => ({
  bot_id: "bot",
  keys,
  events: [],
  waiting: [],
  status,
  started: true,
  created_at: updated_at,
  updated_at,
});

const bot = (name: string) => ({ id: name, name, kind: "github-threads", inbox_ids: [] }) as unknown as Bot;

const snapshot: Snapshot = {
  bots: { held: [bot("dev")], skipped: [bot("ci")] },
  waiting: [{ id: "e1", inbox_id: "in", type: "com.github.push", key: "a/b#9" }],
  sessions: {
    "aaaaaaaa-1": session(["a/b#1"], "active", "2026-01-01T00:00:03Z"),
    "bbbbbbbb-2": session(["a/b#2", "a/b#3"], "active", "2026-01-01T00:00:02Z"),
    "cccccccc-3": session(["a/b#4"], "ended", "2026-01-01T00:00:01Z"),
    "dddddddd-4": session(["a/b#5"], "ended", "2026-01-01T00:00:04Z"),
  },
  running: new Set(["aaaaaaaa-1"]),
  message: "started aaaaaaaa for a/b#1 (1 event)",
};

const log = [
  { type: "system", subtype: "init", session_id: "x" },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Reading the issue." }] } },
  {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Bash", input: { command: "gh issue view 2", description: "Read issue #2" } },
      ],
    },
  },
  { type: "user", message: { content: [{ type: "tool_result", content: "line 1\nline 2\nline 3\nline 4" }] } },
  { type: "user", parent_tool_use_id: "toolu_1", message: { content: [{ type: "text", text: "subagent prompt" }] } },
  {
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "Exit code 1" }] }] },
  },
  { type: "result", subtype: "success", duration_ms: 75_562, total_cost_usd: 0.686 },
]
  .map((r) => JSON.stringify(r))
  .concat("some stderr output")
  .join("\n");

describe("transcriptLines", () => {
  it("shows the session's text, tool calls, short tool results, and runs", () => {
    expect(transcriptLines(log)).toEqual([
      { text: "── run started ──", kind: "meta" },
      { text: "Reading the issue.", kind: "text" },
      { text: "● Bash(Read issue #2)", kind: "tool" },
      { text: "  ⎿ line 1\n    line 2 … (+2 lines)", kind: "result" },
      { text: "  ⎿ Exit code 1", kind: "error" },
      { text: "── run finished (76s, $0.69) ──", kind: "meta" },
      { text: "some stderr output", kind: "error" },
    ]);
  });
});

describe("ThreadsTui", () => {
  let unmount: (() => void) | undefined;
  afterEach(() => unmount?.());

  async function show(snap = snapshot) {
    const app = render(<ThreadsTui load={async () => snap} readLog={async (id) => (id === "bbbbbbbb-2" ? log : "")} />);
    unmount = app.unmount;
    const press = async (key: string) => (app.stdin.write(key), await sleep(30));
    await sleep(30);
    return { frame: () => app.lastFrame() ?? "", press };
  }

  it("lists the bots, waiting messages, and working, waiting and done sessions", async () => {
    const { frame } = await show();
    const f = frame();
    for (const s of [
      "· dev · leased elsewhere: ci",
      "Waiting messages (1)",
      "com.github.push a/b#9",
      "Working (1)",
      "Waiting (1)",
      "Done (2)",
      "started aaaaaaaa",
    ])
      expect(f).toContain(s);
    // Each section in order, done sessions newest first, and the first session selected.
    const at = (s: string) => f.indexOf(s);
    expect(at("Waiting messages")).toBeLessThan(at("Working"));
    expect(at("Working")).toBeLessThan(at("Waiting (1)"));
    expect(at("Waiting (1)")).toBeLessThan(at("Done"));
    expect(at("a/b#5")).toBeLessThan(at("a/b#4"));
    expect(f).toMatch(/❯ a\/b#1/);
  });

  it("moves with the arrows and tab, never onto waiting messages, and opens a transcript until ←", async () => {
    const { frame, press } = await show();
    await press(KEYS.up);
    expect(frame()).toMatch(/❯ a\/b#1/);
    await press(KEYS.down);
    expect(frame()).toMatch(/❯ a\/b#2, a\/b#3/);
    await press(KEYS.tab);
    expect(frame()).toMatch(/❯ a\/b#5/);
    await press(KEYS.tab);
    expect(frame()).toMatch(/❯ a\/b#1/);

    await press(KEYS.down);
    await press(KEYS.enter);
    expect(frame()).toContain("bbbbbbbb · waiting");
    expect(frame()).toContain("● Bash(Read issue #2)");
    expect(frame()).not.toContain("Waiting messages");

    await press(KEYS.left);
    expect(frame()).toMatch(/❯ a\/b#2, a\/b#3/);

    // → opens too; a session with no log says so.
    await press(KEYS.down);
    await press(KEYS.right);
    expect(frame()).toContain("No transcript yet.");
  });

  it("scrolls long lists inside the screen", async () => {
    const sessions = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `s${String(i).padStart(3, "0")}`,
        session([`a/b#${i}`], "ended", `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`),
      ]),
    );
    const { frame, press } = await show({ bots: { held: [], skipped: [] }, waiting: [], sessions, running: new Set() });
    const rows = frame().split("\n").length;
    expect(rows).toBeLessThan(200);
    for (let i = 0; i < 60; i++) await press(KEYS.down);
    // Same height, scrolled past the top, with the selection still on screen.
    expect(frame().split("\n").length).toBe(rows);
    expect(frame()).not.toContain("Waiting messages");
    expect(frame()).toMatch(/❯ a\/b#/);
  });
});
