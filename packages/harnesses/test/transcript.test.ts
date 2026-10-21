import { describe, expect, it } from "vitest";
import { getHarness } from "../src/index.js";

const transcript = (harness: string, log: string) => getHarness(harness).transcript(log);

const codexLog = [
  { type: "thread.started", thread_id: "t" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "Reading the notes." } },
  { type: "item.started", item: { type: "command_execution", command: "ls", exit_code: null } },
  { type: "item.completed", item: { type: "command_execution", command: "ls", exit_code: 0 } },
  { type: "item.completed", item: { type: "command_execution", command: "false", exit_code: 1 } },
  { type: "item.completed", item: { type: "reasoning", text: "hm" } },
  { type: "turn.completed", usage: {} },
]
  .map((r) => JSON.stringify(r))
  .concat("ERROR codex_core::tools::router: error=rejected")
  .join("\n");

describe("transcript", () => {
  it("reads Codex's run start, messages, commands and run end among its stderr", () => {
    expect(transcript("codex", codexLog)).toEqual([
      { text: "── run started ──", kind: "meta" },
      { text: "Reading the notes.", kind: "text" },
      { text: "● ls", kind: "tool" },
      { text: "  ⎿ exit 0", kind: "result" },
      { text: "● false", kind: "tool" },
      { text: "  ⎿ exit 1", kind: "error" },
      { text: "── run finished ──", kind: "meta" },
      { text: "ERROR codex_core::tools::router: error=rejected", kind: "error" },
    ]);
  });

  it("shows a failed Codex turn", () => {
    const log = JSON.stringify({ type: "turn.failed", error: { message: "boom" } });
    expect(transcript("codex", log)).toEqual([{ text: "── run failed: boom ──", kind: "meta" }]);
  });

  it("shows Cursor's tool calls once, when they start", () => {
    const call = (subtype: string) =>
      JSON.stringify({ type: "tool_call", subtype, tool_call: { shellToolCall: { args: { command: "ls -la" } } } });
    expect(transcript("cursor", [call("started"), call("completed")].join("\n"))).toEqual([
      { text: "● shell(ls -la)", kind: "tool" },
    ]);
  });

  it("reads Hermes' result by its exit code", () => {
    const result = (r: object) => transcript("hermes", JSON.stringify({ type: "result", ...r }))[0]!.text;
    expect(result({ exit_code: 0 })).toBe("── run finished ──");
    expect(result({ exit_code: 1, error: "nope" })).toBe("── run failed: nope ──");
  });
});

describe("transcript of a script", () => {
  it("shows its output as it is", () => {
    expect(transcript("script", "one\n\ntwo\n")).toEqual([
      { text: "one", kind: "text" },
      { text: "two", kind: "text" },
    ]);
  });
});
