import { Environment } from "@marcbachmann/cel-js";
import { describe, expect, it } from "vitest";
import { createSources, NO_DEPS } from "../src/index.js";

const ruleSources = createSources(NO_DEPS).ruleSources();

describe("source rules", () => {
  it("lists the sources that define rule helpers", () => {
    expect(ruleSources.map((r) => r.prefix)).toEqual(["com.github."]);
  });

  it("github_closes lists the issues a PR body closes", () => {
    const env = ruleSources[0]!.extend(new Environment({ unlistedVariablesAreDyn: true }));
    expect(env.evaluate("github_closes(body)", { body: "Closes #12, fixes #3 and resolved #7" })).toEqual([
      "12",
      "3",
      "7",
    ]);
    expect(env.evaluate("github_closes(body)", { body: null })).toEqual([]);
  });
});
