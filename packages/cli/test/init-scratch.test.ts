import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stateDir } from "../src/state.js";

const script = join(import.meta.dirname, "../../../tools/init-scratch.mjs");
const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
const commit = (repo: string, message: string) => {
  git("-C", repo, "add", ".");
  git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
  git("-C", repo, "push", "--quiet", "origin", "main");
};

let home: string;
let dir: string;
let remote: string;
let seed: string;

/** Runs the script like `npm run init-scratch -- <args>`, with a local bare repo standing in for the sandbox. */
const init = (...args: string[]) =>
  execFileSync("node", [script, "--dir", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, LOOPWAY_HOME: home, LOOPWAY_SANDBOX_REMOTE: remote, INIT_CWD: "" },
  });

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopway-init-")));
  home = join(root, "home");
  dir = join(root, "scratch");
  remote = join(root, "sandbox.git");
  seed = join(root, "seed");
  git("init", "--bare", "--quiet", "-b", "main", remote);
  git("clone", "--quiet", remote, seed);
  await writeFile(join(seed, "README.md"), "sandbox\n");
  commit(seed, "one");
});

describe("init-scratch", () => {
  it("creates both bots and a clone of the sandbox, and says what to run next", async () => {
    const out = init();
    const dev = await readFile(join(dir, ".loopway/dev.md"), "utf8");
    expect(dev).toContain("repos: [craftmilldev/loopway-sandbox]");
    expect(dev).toContain("on: issue");
    expect(dev).toContain("cwd: sandbox");
    expect(dev).toContain("Do what the issue asks, then comment with the result.");
    expect(await readFile(join(dir, ".loopway/review.md"), "utf8")).toContain("on: pull_request");
    expect(await readFile(join(dir, "sandbox/README.md"), "utf8")).toBe("sandbox\n");
    expect(out).toMatch(/Next: cd .*scratch && (loopway|node .*dist\/index\.js)/);
  });

  it("fast-forwards the sandbox clone when run again", async () => {
    init();
    await writeFile(join(seed, "two.md"), "two\n");
    commit(seed, "two");
    expect(init()).toContain("updated");
    expect(existsSync(join(dir, "sandbox/two.md"))).toBe(true);
  });

  it("keeps a bot file you edited and says so, and --force puts the default back", async () => {
    init();
    const file = join(dir, ".loopway/dev.md");
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("sonnet", "opus"));

    const kept = init();
    expect(kept).toMatch(/kept .*dev\.md/);
    expect(kept).toMatch(/unchanged .*review\.md/);
    expect(await readFile(file, "utf8")).toContain("model: opus");

    expect(init("--force")).toMatch(/reset .*dev\.md/);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("--reset clears this project's state and no other project's", async () => {
    init();
    const mine = stateDir(home, dir);
    const other = stateDir(home, join(dir, "..", "other"));
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
