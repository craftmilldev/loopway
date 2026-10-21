import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { emptyChat, NO_AGENT_REPLY, submitMessage } from "../src/bots/chat.js";

describe("chat", () => {
  it("starts empty", () => {
    expect(emptyChat().messages).toEqual([]);
  });

  it("adds what you wrote and the placeholder reply, in order", () => {
    const one = submitMessage(emptyChat(), "  hello  ");
    expect(one.messages).toEqual([
      { from: "you", text: "hello" },
      { from: "manager", text: NO_AGENT_REPLY },
    ]);
    const two = submitMessage(one, "again");
    expect(two.messages.map((m) => m.text)).toEqual(["hello", NO_AGENT_REPLY, "again", NO_AGENT_REPLY]);
    // The earlier state is untouched.
    expect(one.messages).toHaveLength(2);
  });

  it("drops a message that is only whitespace", () => {
    const chat = emptyChat();
    expect(submitMessage(chat, " \t ")).toBe(chat);
  });

  it("imports no ink, so a web UI can reuse it", async () => {
    const src = await readFile(new URL("../src/bots/chat.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["'](ink|react)/);
  });
});
