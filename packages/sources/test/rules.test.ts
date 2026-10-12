import { Environment } from "@marcbachmann/cel-js";
import { describe, expect, it } from "vitest";
import { createSources, NO_DEPS } from "../src/index.js";

const rules = createSources(NO_DEPS).rules();

describe("source rules", () => {
  it("lists the sources that define rule helpers", () => {
    expect(rules.map(([prefix]) => prefix)).toEqual(["com.github."]);
  });

  it("github_closes lists the issues a PR body closes", () => {
    const env = rules[0]![1](new Environment({ unlistedVariablesAreDyn: true }));
    expect(env.evaluate("github_closes(body)", { body: "Closes #12, fixes #3 and resolved #7" })).toEqual([
      "12",
      "3",
      "7",
    ]);
    expect(env.evaluate("github_closes(body)", { body: null })).toEqual([]);
  });
});
