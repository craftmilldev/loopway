import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "../../../tools/sandbox.mjs");

let dir: string;
let calls: string;

/** A fake `gh` that logs its arguments and answers `issue list` and `pr list` from canned JSON. */
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loopway-sandbox-"));
  calls = join(dir, "calls.log");
  const fake = join(dir, "gh");
  await writeFile(
    fake,
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n");
if (a[0] === "issue" && a[1] === "list") console.log(JSON.stringify([
  { number: 4, title: "[#9] mine", state: "OPEN" },
  { number: 5, title: "[#99] someone else's", state: "OPEN" },
]));
else if (a[0] === "pr" && a[1] === "list") console.log(JSON.stringify([{ number: 6, title: "[#9] pr", state: "OPEN", headRefName: "br" }]));
else if (a[0] === "issue" && a[1] === "create") console.log("https://github.com/craftmilldev/loopway-sandbox/issues/7");
`,
  );
  await chmod(fake, 0o755);
});

const run = (...args: string[]) =>
  execFileSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, GH: join(dir, "gh") } });

describe("sandbox", () => {
  it("opens an issue in the sandbox with the PR number in the title", async () => {
    expect(run("open", "9", "reopen starts a new thread")).toContain("/issues/7");
    const log = await readFile(calls, "utf8");
    expect(log).toContain("issue create -R craftmilldev/loopway-sandbox --title [#9] reopen starts a new thread");
  });

  it("lists and closes only titles tagged with this PR, and deletes the PR's branch", async () => {
    expect(run("list", "9")).toBe("issue #4 open [#9] mine\npr #6 open [#9] pr\n");
    const out = run("close", "9");
    expect(out).toContain("closed issue #4");
    expect(out).toContain("closed pr #6");
    const log = await readFile(calls, "utf8");
    expect(log).toContain("issue close 4 -R craftmilldev/loopway-sandbox");
    expect(log).toContain("pr close 6 -R craftmilldev/loopway-sandbox");
    expect(log).toContain("repos/craftmilldev/loopway-sandbox/git/refs/heads/br");
    expect(log).not.toContain("close 5");
  });

  it("needs a PR number", () => {
    expect(() => execFileSync("node", [script, "open", "x", "t"], { stdio: "pipe" })).toThrow();
  });
});
