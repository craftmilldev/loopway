import { describe, expect, it } from "vitest";
import { lookups, route, THREAD_MESSAGE_TYPE, type BotRule } from "../src/index.js";

const RULES: BotRule[] = [
  {
    types: ["pr.*"],
    subject: "'pr-' + string(data.number)",
    related: "['issue-' + string(data.issue)]",
    action: "'attach'",
  },
  { types: ["pr.*", "push"], subject: "'repo-' + data.repo", action: "held ? 'attach' : 'skip'" },
  { types: ["issue.*"], subject: "''", action: "'attach'" },
];

describe("lookups", () => {
  it("names every subject a matching rule can ask about, and only those", () => {
    const e = { event: { type: "pr.opened", data: { number: 7, issue: 3, repo: "r" } } };
    expect(lookups(RULES, e)).toEqual({ subjects: ["pr-7", "issue-3", "repo-r"], threads: [] });
    // route() asks nothing outside them: a map of just these routes it as one of every subject would.
    const asked: string[] = [];
    const held = new Map([["pr-7", "t1"]]);
    const spy = { get: (k: string) => (asked.push(k), held.get(k)), has: (k: string) => (asked.push(k), held.has(k)) };
    expect(route(RULES, spy as unknown as Map<string, string>, e)?.thread_id).toBe("t1");
    expect(asked.every((k) => lookups(RULES, e).subjects.includes(k))).toBe(true);
  });

  it("asks nothing for a rule with no subject, or a type no rule takes", () => {
    expect(lookups(RULES, { event: { type: "issue.opened", data: {} } })).toEqual({ subjects: [], threads: [] });
    expect(lookups(RULES, { event: { type: "deploy", data: {} } })).toEqual({ subjects: [], threads: [] });
  });

  it("names the thread of a message sent to a thread", () => {
    const e = { event: { type: THREAD_MESSAGE_TYPE, data: { thread_id: "t9", bot_id: "b" } } };
    expect(lookups(RULES, e)).toEqual({ subjects: [], threads: ["t9"] });
  });

  it("leaves out a rule whose expression throws, which route() reports", () => {
    const bad: BotRule[] = [{ types: ["*"], subject: "data.missing.deeper", action: "'attach'" }];
    const e = { event: { type: "x", data: {} } };
    expect(lookups(bad, e)).toEqual({ subjects: [], threads: [] });
    expect(() => route(bad, new Map(), e)).toThrow();
  });
});
