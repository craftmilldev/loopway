import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBots, parseBot, reposOf } from "../src/bots.js";
import { loadGitHubConfig, loopwayHome } from "../src/config.js";
import { formatJson, formatLine } from "../src/format.js";
import { emptyState, loadState, saveState } from "../src/state.js";

const tmp = () => mkdtemp(join(tmpdir(), "loopway-test-"));

describe("bots", () => {
  it("reads front matter as rules and the Markdown as the prompt", () => {
    const bot = parseBot("dev", "---\nrepos: [a/b, c/d]\non: issue\nharness: claude\n---\n\nYou are the dev bot.\n");
    expect(bot.repos).toEqual(["a/b", "c/d"]);
    expect(bot.rules).toMatchObject({ on: "issue", harness: "claude" }); // unknown keys are kept, not an error
    expect(bot.prompt).toBe("You are the dev bot.");
  });

  it("takes a block list, or a single repo", () => {
    expect(parseBot("x", "---\nrepos:\n  - a/b\n  - c/d\n---\n").repos).toEqual(["a/b", "c/d"]);
    expect(parseBot("x", "---\nrepos: a/b\n---\n").repos).toEqual(["a/b"]);
  });

  it("allows a file with no front matter", () => {
    const bot = parseBot("x", "Just a prompt.");
    expect(bot.repos).toEqual([]);
    expect(bot.prompt).toBe("Just a prompt.");
  });

  it("rejects a repo that is not owner/name, and bad YAML, naming the file", () => {
    expect(() => parseBot("x", "---\nrepos: [nope]\n---\n", ".loopway/x.md")).toThrow(/\.loopway\/x\.md.*owner\/name/);
    expect(() => parseBot("x", "---\nrepos: [a/b\n---\n", ".loopway/x.md")).toThrow(/not valid YAML/);
  });

  it("loads every .md in .loopway and polls the union of their repos", async () => {
    const dir = await tmp();
    await mkdir(join(dir, ".loopway"));
    await writeFile(join(dir, ".loopway", "dev.md"), "---\nrepos: [a/b, c/d]\n---\ndev");
    await writeFile(join(dir, ".loopway", "review.md"), "---\nrepos: [c/d, e/f]\n---\nreview");
    await writeFile(join(dir, ".loopway", "notes.txt"), "ignored");
    const bots = await loadBots(dir);
    expect(bots.map((b) => b.name)).toEqual(["dev", "review"]);
    expect(reposOf(bots)).toEqual(["a/b", "c/d", "e/f"]);
  });

  it("finds no bots when there is no .loopway folder", async () => {
    expect(await loadBots(await tmp())).toEqual([]);
  });
});

describe("config", () => {
  it("reads only the github block", async () => {
    const home = await tmp();
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ api_url: "x", api_key: "y", github: { token: "t", name: "loopway-bot", email: "e", extra: 1 } }),
    );
    expect(await loadGitHubConfig(home)).toEqual({ token: "t", name: "loopway-bot", email: "e" });
  });

  it("is empty without a file or a block", async () => {
    const home = await tmp();
    expect(await loadGitHubConfig(home)).toEqual({});
    await writeFile(join(home, "config.json"), "{}");
    expect(await loadGitHubConfig(home)).toEqual({});
  });

  it("LOOPWAY_HOME moves the home", () => {
    expect(loopwayHome({ LOOPWAY_HOME: "/x" })).toBe("/x");
  });
});

describe("state", () => {
  it("round-trips, and starts empty", async () => {
    const home = await tmp();
    expect(await loadState(home)).toEqual(emptyState());
    const state = emptyState();
    state.repos["a/b"] = { since: "2026-11-10T12:00:00.000Z" };
    await saveState(home, state);
    expect(await loadState(home)).toEqual(state);
  });
});

describe("output", () => {
  const subject = {
    key: "o/r#12",
    kind: "issue" as const,
    title: "Fix it",
    author: "mcwhittemore",
    createdAt: "2026-11-10T14:02:00Z",
  };
  const update = { id: "comment:1", kind: "comment", actor: "loopway-bot", at: "2026-11-10T14:05:00Z" };

  it("prints one line per event", () => {
    expect(formatLine({ type: "new", subject })).toBe('2026-11-10 14:02 new    o/r#12 issue "Fix it" by mcwhittemore');
    expect(formatLine({ type: "new", subject: { ...subject, kind: "pull_request" } })).toContain(" pr ");
    expect(formatLine({ type: "update", subject: "o/r#12", update })).toBe(
      "2026-11-10 14:05 update o/r#12 comment by loopway-bot",
    );
    expect(
      formatLine({ type: "update", subject: "o/r#12", update: { ...update, kind: "labeled", detail: "bug" } }),
    ).toBe("2026-11-10 14:05 update o/r#12 labeled bug by loopway-bot");
  });

  it("prints NDJSON with --json", () => {
    expect(JSON.parse(formatJson({ type: "new", subject }))).toEqual({
      type: "new",
      time: "2026-11-10T14:02:00Z",
      subject: "o/r#12",
      kind: "issue",
      title: "Fix it",
      author: "mcwhittemore",
    });
    expect(JSON.parse(formatJson({ type: "update", subject: "o/r#12", update }))).toMatchObject({
      type: "update",
      subject: "o/r#12",
      kind: "comment",
      actor: "loopway-bot",
    });
  });
});
