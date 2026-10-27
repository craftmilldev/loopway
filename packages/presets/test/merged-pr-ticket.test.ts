import { route } from "@loopway/rules";
import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/index.js";

const rules = PRESETS["merged-pr-ticket"]!.rules;
const repository = { full_name: "acme/app" };
const user = { login: "sam", type: "User" };
const closed = (merged: boolean) => ({
  event: {
    type: "com.github.pull_request.closed",
    data: { repository, sender: user, pull_request: { number: 7, merged } },
  },
});

describe("merged-pr-ticket rules", () => {
  it("attaches a merged pull request to its own thread", () => {
    const r = route(rules, new Map(), closed(true));
    expect(r?.key).toBe("acme/app#7");
    expect(r?.add_subjects).toEqual(["acme/app#7"]);
    expect(r?.author_kind).toBe("human");
  });

  it("skips a pull request closed without merging", () => {
    expect(route(rules, new Map(), closed(false))).toBeUndefined();
  });

  it("skips other events", () => {
    for (const type of [
      "com.github.pull_request.opened",
      "com.github.issues.closed",
      "com.github.check_run.completed",
    ]) {
      const data = { repository, sender: user, pull_request: { number: 7, merged: true }, issue: { number: 3 } };
      expect(route(rules, new Map(), { event: { type, data } })).toBeUndefined();
    }
  });
});
