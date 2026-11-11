import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stateDir } from "../src/state.js";

const script = join(import.meta.dirname, "../../../tools/init-scratch.mjs");

let root: string;
let home: string;
let dir: string;

/** Runs the script like `npm run init-scratch -- <args>`, from `root`, with a temp `LOOPWAY_HOME`. */
const init = (...args: string[]) =>
  execFileSync("node", [script, "--dir", "scratch", ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, LOOPWAY_HOME: home, INIT_CWD: "" },
  });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "loopway-init-")));
  home = join(root, "home");
  dir = join(root, "scratch");
});

describe("init-scratch", () => {
  it("creates both bots on the sandbox repo, with relative paths", async () => {
    const out = init();
    const dev = await readFile(join(dir, ".loopway/dev.md"), "utf8");
    expect(dev).toContain("repos: [craftmilldev/loopway-sandbox]");
    expect(dev).toContain("on: issue");
    expect(dev).toContain("Do what the issue asks, then comment with the result.");
    expect(dev).not.toContain("cwd");
    expect(await readFile(join(dir, ".loopway/review.md"), "utf8")).toContain("on: pull_request");
    expect(existsSync(join(dir, "sandbox"))).toBe(false);
    expect(out).toContain("created    scratch/.loopway/dev.md\n");
    expect(out).not.toContain(root);
  });

  it("keeps a bot file you edited and says so, and --force puts the default back", async () => {
    init();
    const file = join(dir, ".loopway/dev.md");
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("sonnet", "opus"));

    const kept = init();
    expect(kept).toMatch(/kept .*scratch\/\.loopway\/dev\.md/);
    expect(kept).toMatch(/unchanged .*review\.md/);
    expect(await readFile(file, "utf8")).toContain("model: opus");

    expect(init("--force")).toMatch(/reset .*dev\.md/);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("--reset clears this project's state and no other project's", async () => {
    init();
    const mine = stateDir(home, dir);
    const other = stateDir(home, join(root, "other"));
    for (const state of [mine, other]) {
      await mkdir(join(state, "threads"), { recursive: true });
      await writeFile(join(state, "threads/a.json"), "{}");
    }

    init();
    expect(existsSync(mine)).toBe(true); // without --reset, nothing is cleared

    expect(init("--reset")).toContain("cleared");
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(join(other, "threads/a.json"))).toBe(true);
  });
});
