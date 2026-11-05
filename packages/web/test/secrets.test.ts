import { describe, expect, it } from "vitest";
import { secretBox } from "../src/secrets.js";
import { TEST_INBOX_KEY } from "../src/db/testing.js";

const box = secretBox(TEST_INBOX_KEY);

describe("secretBox", () => {
  it("round-trips and does not repeat itself", () => {
    const a = box.seal("hunter2hunter2hunter2", "inbox-1");
    expect(a).not.toContain("hunter2");
    expect(box.open(a, "inbox-1")).toBe("hunter2hunter2hunter2");
    expect(box.seal("hunter2hunter2hunter2", "inbox-1")).not.toBe(a);
  });
  it("refuses another context, another key or a changed value", () => {
    const a = box.seal("s", "inbox-1");
    expect(() => box.open(a, "inbox-2")).toThrow();
    expect(() => secretBox(Buffer.alloc(32, "other").toString("base64")).open(a, "inbox-1")).toThrow();
    expect(() => box.open(a.slice(0, -2) + "AA", "inbox-1")).toThrow();
  });
  it("needs a 32-byte key", () => {
    expect(() => secretBox(undefined)).toThrow(/32 bytes/);
    expect(() => secretBox("c2hvcnQ=")).toThrow(/32 bytes/);
  });
});
