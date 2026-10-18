import { FAINT, INDIGO, INK, MADDER } from "@loopway/palette";
import chalk from "chalk";
import { render } from "ink-testing-library";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bot, Thread } from "../src/client.js";
import { nearest256, termColor } from "../src/bots/colors.js";
import { transcriptLines } from "../src/bots/transcript.js";
import { ThreadsTui, type Snapshot } from "../src/bots/tui.js";
import { clock } from "../src/format.js";
import { CLI_VERSION } from "../src/version.js";

const KEYS = { up: "\u001B[A", down: "\u001B[B", right: "\u001B[C", left: "\u001B[D", enter: "\r", tab: "\t" };

const thread = (
  subjects: string[],
  status: Thread["status"],
  updated_at: string,
  runner_id: string | null = "me",
  more: Partial<Thread> = {},
): Thread => ({
  id: "",
  bot_id: "dev",
  created_by: "bot:dev",
  status,
  started: true,
  interrupted: false,
  limited: false,
  runner_id,
  subjects,
  waiting: [],
  inflight: [],
  delivered: 0,
  created_at: updated_at,
  updated_at,
  ...more,
});

const bot = (name: string) => ({ id: name, name, kind: "github-threads", inbox_ids: [] }) as unknown as Bot;

const LEASED_UNTIL = "2026-01-01T14:32:00Z";

// A thread in each state (working, waiting, limited, stranded, done) and at each level, a/b#2 with none set.
const snapshot: Snapshot = {
  bots: {
    held: [bot("dev")],
    skipped: [{ ...bot("ci"), leased_until: LEASED_UNTIL, held_by: "laptop" }],
    unleased: [],
  },
  leaseBots: true,
  waiting: [
    { id: "e1", inbox_id: "in", type: "com.github.push", subject: "a/b#9", thread_id: "aaaaaaaa-1", bot_name: "dev" },
  ],
  threads: {
    "aaaaaaaa-1": thread(["a/b#1"], "active", "2026-01-01T00:00:03Z", "me", {
      automation_level: 4,
      title: "Fix the sandbox",
    }),
    "bbbbbbbb-2": thread(["a/b#2", "a/b#3"], "active", "2026-01-01T00:00:02Z"),
    "eeeeeeee-5": thread(["a/b#6"], "active", "2026-01-01T00:00:00Z", "me", { limited: true, automation_level: 3 }),
    "ffffffff-6": thread(["a/b#7"], "active", "2025-12-31T23:59:00Z", "gone-id", { automation_level: 4 }),
    "cccccccc-3": thread(["a/b#4"], "ended", "2026-01-01T00:00:01Z", "me", { automation_level: 3 }),
    "dddddddd-4": thread(["a/b#5"], "ended", "2026-01-01T00:00:04Z", "laptop-id"),
  },
  runnerId: "me",
  runners: { me: "desk", "laptop-id": "laptop", "gone-id": "old" },
  offline: new Set(["gone-id"]),
  running: new Set(["aaaaaaaa-1"]),
  message: "started aaaaaaaa for a/b#1 (1 event)",
};

/** The escape that sets a truecolor foreground or background. */
const fg = (hex: string) => `\u001B[38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const bg = (hex: string) => fg(hex).replace("[38;", "[48;");
const BAND = "#3a352b";

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
  let level: typeof chalk.level;
  // Truecolor, as most terminals have, so the colors are in the frames.
  beforeEach(() => {
    level = chalk.level;
    chalk.level = 3;
  });
  afterEach(() => {
    unmount?.();
    chalk.level = level;
  });

  const sent: [string, string][] = [];
  const ended: string[] = [];

  async function show(snap = snapshot) {
    const app = render(
      <ThreadsTui
        load={async () => snap}
        readLog={async (id) => (id === "bbbbbbbb-2" ? log : "")}
        send={async (id, text) => void sent.push([id, text])}
        end={async (id) => void ended.push(id)}
        org="acme"
      />,
    );
    unmount = app.unmount;
    const press = async (key: string) => (app.stdin.write(key), await sleep(30));
    await sleep(30);
    const raw = () => app.lastFrame() ?? "";
    return {
      raw,
      frame: () => plain(raw()),
      /** The line with `text` in it, colors and all. */
      line: (text: string) =>
        raw()
          .split("\n")
          .find((l) => plain(l).includes(text)) ?? "",
      /** The text of the row on the selection band. */
      selected: () =>
        plain(
          raw()
            .split("\n")
            .find((l) => l.includes(bg(BAND))) ?? "",
        ),
      press,
    };
  }

  it("lists the bots, waiting messages, and working, waiting and done sessions", async () => {
    const { frame, selected } = await show();
    const f = frame();
    for (const s of [
      `LOOPWAY · runner desk · org acme · v${CLI_VERSION}`,
      `holds dev · skipped ci, held by laptop until ${clock(LEASED_UNTIL)}`,
      "WAITING MESSAGES 1 ───",
      "com.github.push on a/b#9",
      "aaaaaaaa working",
      "a/b#1 Fix the sandbox",
      "WORKING 1 ───",
      "WAITING 3 ───",
      "DONE 2 ───",
      "started aaaaaaaa",
      "on laptop",
      "q quit",
    ])
      expect(f).toContain(s);
    // Each section in order, done sessions newest first, and the first session selected.
    const at = (s: string) => f.indexOf(s);
    expect(at("WAITING MESSAGES")).toBeLessThan(at("WORKING"));
    expect(at("WORKING")).toBeLessThan(at("WAITING 3"));
    expect(at("WAITING 3")).toBeLessThan(at("DONE"));
    expect(at("a/b#5")).toBeLessThan(at("a/b#4"));
    expect(selected()).toContain("a/b#1");
  });

  it("marks each row with its state's dot and its level, in the palette's ink colors", async () => {
    const { line, raw } = await show();
    const row = (text: string, dot: string | undefined, lvl: string, color: string) => {
      const l = line(text);
      expect(plain(l)).toContain(dot ? `● dev` : "  dev");
      if (dot) expect(l).toContain(`${fg(dot)}●`);
      expect(l).toContain(`${fg(color)}${lvl}`);
    };
    row("a/b#1", INDIGO.ink, "L4", MADDER.ink); // working
    row("a/b#2", INK.ink, "L2", FAINT.ink); // waiting, no level set
    row("a/b#6", MADDER.ink, "L3", INDIGO.ink); // limited
    row("a/b#7", MADDER.ink, "L4", MADDER.ink); // stranded
    row("a/b#4", undefined, "L3", FAINT.ink); // done: no dot, dim level
    expect(plain(line("a/b#6"))).toContain("limited · eeeeeeee");
    expect(plain(line("a/b#7"))).toContain("stranded · ffffffff");
    expect(plain(line("a/b#4"))).toContain("ended");
    // A waiting message gets a ring and no level.
    expect(plain(line("a/b#9"))).toMatch(/^○ dev +com\.github\.push on a\/b#9 +aaaaaaaa working/);
    // No terminal cyan or red is left.
    for (const code of ["\u001B[31m", "\u001B[36m"]) expect(raw()).not.toContain(code);
  });

  it("falls back to the nearest of the 256 colors without truecolor", async () => {
    chalk.level = 2;
    const { line } = await show();
    expect(line("a/b#1")).toContain(`\u001B[38;5;${nearest256(INDIGO.ink)}m●`);
    expect(termColor(INDIGO.ink, 2)).toBe(`ansi256(${nearest256(INDIGO.ink)})`);
    expect(termColor(INDIGO.ink, 3)).toBe(INDIGO.ink);
    // Black, white and a gray land on the cube and the gray ramp, never on the 16 a theme decides.
    expect([nearest256("#000000"), nearest256("#ffffff"), nearest256("#808080")]).toEqual([16, 231, 244]);
  });

  // With 16 colors the band would be the terminal's black, as good as none.
  it.each([0, 1] as const)("marks the selection where the band can't show (color level %i)", async (l) => {
    chalk.level = l;
    const { frame } = await show();
    expect(frame()).toMatch(/^› dev +a\/b#1/m);
    expect(frame()).toMatch(/^● dev +a\/b#2/m);
  });

  it("moves with the arrows and tab, never onto waiting messages, and opens a transcript until ←", async () => {
    const { frame, line, selected, press } = await show();
    await press(KEYS.up);
    expect(selected()).toContain("a/b#1");
    await press(KEYS.down);
    expect(selected()).toContain("a/b#2, a/b#3");
    expect(line("a/b#1")).not.toContain(bg(BAND));
    await press(KEYS.tab);
    expect(selected()).toContain("a/b#5");
    await press(KEYS.tab);
    expect(selected()).toContain("a/b#1");

    await press(KEYS.down);
    await press(KEYS.enter);
    // The header shows the thread's state and level as the list does; tool calls and errors take the palette's colors.
    expect(frame()).toMatch(/^● dev a\/b#2, a\/b#3 L2 · bbbbbbbb · waiting/);
    expect(line("bbbbbbbb")).toContain(`${fg(INK.ink)}●`);
    expect(line("● Bash(Read issue #2)")).toContain(fg(INDIGO.ink));
    expect(line("Exit code 1")).toContain(fg(MADDER.ink));
    expect(frame()).not.toContain("WAITING MESSAGES");

    await press(KEYS.left);
    expect(selected()).toContain("a/b#2, a/b#3");

    // → opens too; a session with no log says so.
    await press(KEYS.down);
    await press(KEYS.right);
    expect(frame()).toContain("No transcript yet.");
    expect(frame()).toContain("eeeeeeee · limited");
  });

  it("writes a message to an open thread with m, sends it with enter and drops it with esc", async () => {
    const { frame, line, press } = await show();
    await press(KEYS.down);
    await press(KEYS.enter);
    await press("m");
    await press("hi");
    expect(frame()).toContain("message ❯ hi");
    expect(line("message ❯")).toContain(`${fg(INDIGO.ink)}message ❯`);
    await press("\u001B");
    await sleep(60);
    expect(frame()).not.toContain("message ❯");
    expect(sent).toEqual([]);

    await press("m");
    await press("ok");
    await press(KEYS.enter);
    expect(sent.map(([, text]) => text)).toEqual(["ok"]);
    expect(frame()).toContain(sent[0]![0].slice(0, 8));
    expect(frame()).toContain("message sent");
  });

  it("ends an open thread with e then y, and keeps it on e then any other key", async () => {
    const { frame, press } = await show();
    await press(KEYS.down);
    await press(KEYS.enter);
    await press("e");
    expect(frame()).toContain("end this thread?");
    await press("n");
    expect(frame()).toContain("end canceled");
    expect(ended).toEqual([]);

    await press("e");
    await press("y");
    expect(ended).toHaveLength(1);
    expect(frame()).toContain("thread ended");
  });

  it("scrolls long lists inside the screen", async () => {
    const threads = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `s${String(i).padStart(3, "0")}`,
        thread([`a/b#${i}`], "ended", `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`),
      ]),
    );
    const { frame, selected, press } = await show({
      bots: { held: [], skipped: [], unleased: [] },
      leaseBots: true,
      waiting: [],
      threads,
      runnerId: "me",
      runners: {},
      offline: new Set(),
      running: new Set(),
    });
    const rows = frame().split("\n").length;
    expect(rows).toBeLessThan(200);
    expect(frame()).toContain("holds no bots");
    for (let i = 0; i < 60; i++) await press(KEYS.down);
    // Same height, scrolled past the top, with the selection still on screen.
    expect(frame().split("\n").length).toBe(rows);
    expect(frame()).not.toContain("WAITING MESSAGES");
    expect(selected()).toMatch(/a\/b#/);
  });
});
