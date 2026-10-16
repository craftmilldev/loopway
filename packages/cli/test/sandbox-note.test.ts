import { describe, expect, it } from "vitest";
import { sandboxDenialNote } from "../src/bots/dispatcher.js";

describe("sandboxDenialNote", () => {
  it("lists the denials, without telling the bot to leave the sandbox", () => {
    const note = sandboxDenialNote(["mkdir: /x: Operation not permitted"]);
    expect(note).toContain("1 tool call in this run look like sandbox denials");
    expect(note).toContain("  mkdir: /x: Operation not permitted");
    expect(note).not.toContain("--no-sandbox");
    expect(sandboxDenialNote(["a", "b"])).toContain("2 tool calls");
  });
});
