import { Environment } from "@marcbachmann/cel-js";
import { describe, expect, it } from "vitest";
import { sources } from "../src/index.js";

describe("source rules", () => {
  it("lists the rule helpers of the sources that define them", () => {
    expect(sources.ruleSources().map((r) => r.prefix)).toEqual(["com.github."]);
  });

  it("github_closes lists the issues a PR body closes", () => {
    const rules = sources.get("github")!.rules!;
    const env = rules.extend(new Environment({ unlistedVariablesAreDyn: true }));
    expect(env.evaluate("github_closes(body)", { body: "Closes #12, fixes #3 and resolved #7" })).toEqual([
      "12",
      "3",
      "7",
    ]);
    expect(env.evaluate("github_closes(body)", { body: null })).toEqual([]);
  });
});
