import { Environment } from "@marcbachmann/cel-js";
import { describe, expect, it } from "vitest";
import { SourceRegistry, type SourceAdapter } from "../src/index.js";

const adapter = (type: string, rules?: SourceAdapter["rules"]): SourceAdapter => ({
  type,
  label: type,
  description: "",
  events: [],
  secret: { from: "loopway", minLength: 1 },
  webhookSettings: "",
  parseConfig: (input) => input,
  publicConfig: (config) => config,
  rules,
  receive: () => {
    throw new Error("unused");
  },
});

describe("source rules", () => {
  it("lists the helpers of the sources that define some, by event type prefix", () => {
    const registry = new SourceRegistry([
      adapter("a", { "com.a.": (env) => env.registerFunction("a_double(int): int", (n: bigint) => n * 2n) }),
      adapter("b"),
    ]);
    const rules = registry.rules();
    expect(rules.map(([prefix]) => prefix)).toEqual(["com.a."]);
    const env = rules[0]![1](new Environment({ unlistedVariablesAreDyn: true }));
    expect(env.evaluate("a_double(2)")).toBe(4n);
  });
});
