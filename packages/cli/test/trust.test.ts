import { describe, expect, it } from "vitest";
import { parseBot } from "../src/bots.js";
import { resolveTrust } from "../src/trust.js";
import { FakeSource } from "./fake.js";

const bot = (name: string, trusted: string) => parseBot(name, `---\nrepos: [o/r]\ntrusted: ${trusted}\n---\n`);

describe("trusted in a bot file", () => {
  it("is a list of logins and org/team slugs, empty when left out", () => {
    expect(bot("dev", "[alice, acme/devs]").trusted).toEqual(["alice", "acme/devs"]);
    expect(parseBot("dev", "---\nrepos: [o/r]\n---\n").trusted).toEqual([]);
  });

  it("refuses anything else, naming the file", () => {
    expect(() => bot("dev", "[a b]")).toThrow(/dev.*trusted/);
    expect(() => bot("dev", "[1, {a: b}]")).toThrow(/trusted/);
  });
});

describe("resolving who each bot trusts", () => {
  it("always trusts you and the bot user, then the logins and the members of the teams, per bot", async () => {
    const source = new FakeSource();
    source.teams.set("acme/devs", ["Bob", "carol"]);
    const trust = await resolveTrust(
      [bot("dev", "[alice, acme/devs]"), bot("review", "[]")],
      source,
      "me",
      "loopway-bot",
    );
    expect(trust.trusts("dev", "ME")).toBe(true);
    expect(trust.trusts("dev", "loopway-bot")).toBe(true);
    expect(trust.trusts("dev", "bob")).toBe(true);
    expect(trust.trusts("dev", "alice")).toBe(true);
    expect(trust.trusts("review", "bob")).toBe(false);
    expect(trust.trusts("review", "me")).toBe(true);
    expect(trust.trusts("nobody", "me")).toBe(false);
    expect(trust.everyone.sort()).toEqual(["alice", "bob", "carol", "loopway-bot", "me"]);
  });

  it("fails, naming the team, when a team can't be read", async () => {
    await expect(resolveTrust([bot("dev", "[acme/ghosts]")], new FakeSource(), "me")).rejects.toThrow(
      /Can't read the team acme\/ghosts.*won't run/,
    );
  });
});
