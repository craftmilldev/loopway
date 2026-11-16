import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { explainTool, logRows, parseLog } from "../src/tui-log.js";

const LOG = [
  "-> delivered 2 updates",
  "── run started ──",
  "I'll read the issue first.",
  "with a second line",
  "● Bash(gh issue view 550)",
  "  ⎿ the issue text",
  "● mcp__loopway__comment(o/r#12)",
  "<- comment o/r#12 https://github.com/o/r/1",
  "turn ended without a message",
  "── run finished ──",
  "── chat started ──",
  "you> hello there",
  "-> delivered 0 updates",
  "── run started ──",
  "● Read(/tmp/x)",
].join("\n");

describe("parseLog", () => {
  it("makes a turn of each run, with the updates delivered as a detail of it", () => {
    const turns = parseLog(LOG).filter((i) => i.type === "turn");
    expect(turns.map((t) => [t.turn.number, t.turn.delivered, t.turn.state])).toEqual([
      [1, 2, "finished"],
      [2, 0, "running"],
    ]);
  });

  it("keeps a message with several lines as one entry, and drops what a tool returned", () => {
    const first = parseLog(LOG).find((i) => i.type === "turn")!;
    expect(first.type === "turn" && first.turn.entries.map((e) => e.type)).toEqual([
      "say",
      "tool",
      "tool",
      "sent",
      "note",
    ]);
  });

  it("shows a chat starting between turns, and what you typed outside a turn on its own", () => {
    const types = parseLog(LOG).map((i) => i.type);
    expect(types).toEqual(["turn", "divider", "loose", "turn"]);
  });

  it("marks a run that failed, and one that was cut off by the next", () => {
    const items = parseLog("── run started ──\n── run started ──\n!! run failed: boom");
    expect(items.map((i) => i.type === "turn" && i.turn.state)).toEqual(["stopped", "failed"]);
  });
});

describe("explainTool", () => {
  it("says what a call did, as a sentence", () => {
    expect(explainTool("Bash", "npm test")).toBe("Ran npm test");
    expect(explainTool("Edit", "src/a.ts")).toBe("Edited src/a.ts");
    expect(explainTool("mcp__loopway__comment", "o/r#12")).toBe("Commented on o/r#12");
    expect(explainTool("mcp__loopway__create_pr", "o/r")).toBe("Opened a pull request in o/r");
    expect(explainTool("Task", "find the bug")).toBe("Asked a helper: find the bug");
    expect(explainTool("TodoWrite", "{}")).toBe("Updated its plan");
  });

  it("falls back to the tool's name for one it doesn't know", () => {
    expect(explainTool("mcp__x__frob", "a b")).toBe("Used frob: a b");
  });
});

describe("logRows", () => {
  const text = (log: string) =>
    logRows(log).map((r) => stripVTControlCharacters(r.gutter + r.parts.map((p) => p.text).join("")));

  it("draws each turn as a block: a top with its number and updates, the entries, and a bottom", () => {
    expect(text(LOG)).toEqual([
      "╭─ Turn 1 · 2 updates · finished",
      "│  I'll read the issue first.",
      "│  with a second line",
      "│  ▸ Ran gh issue view 550",
      "│  ▸ Commented on o/r#12",
      "│  ✉ comment o/r#12 https://github.com/o/r/1",
      "│  · turn ended without a message",
      "╰─ finished",
      "· chat started ·",
      "you hello there",
      "╭─ Turn 2 · 0 updates · running",
      "│  ▸ Read /tmp/x",
    ]);
  });
});
