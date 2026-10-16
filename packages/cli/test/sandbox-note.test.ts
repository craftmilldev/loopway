import { describe, expect, it } from "vitest";
import { sandboxDenialNote } from "../src/bots/dispatcher.js";

describe("sandboxDenialNote", () => {
  it("lists the denials and points at --no-sandbox", () => {
    const note = sandboxDenialNote(["mkdir: /x: Operation not permitted"]);
    expect(note).toContain("1 tool call in this run look like sandbox denials");
    expect(note).toContain("  mkdir: /x: Operation not permitted");
    expect(note).toContain("--no-sandbox");
    expect(sandboxDenialNote(["a", "b"])).toContain("2 tool calls");
  });
});
