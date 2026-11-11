#!/usr/bin/env node
// Sets up a scratch project to run loopway against the sandbox repo: `npm run init-scratch [-- --dir <path>] [--force] [--reset]`.
// Plain Node, no dependencies. See AGENTS.md and docs/developing.md.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SANDBOX = "craftmilldev/loopway-sandbox";
const CHECKOUT = resolve(fileURLToPath(import.meta.url), "../..");

const bot = (on, prompt) => `---\nrepos: [${SANDBOX}]\non: ${on}\nmodel: sonnet\ncwd: sandbox\n---\n\n${prompt}\n`;
const BOTS = {
  "dev.md": bot("issue", "Do what the issue asks, then comment with the result."),
  "review.md": bot("pull_request", "Review the PR in one comment."),
};

/** The same slug as `slugOf` and `stateDir` in packages/cli/src/state.ts (the test checks they agree). */
const stateDirOf = (home, dir) => join(home, "state", join(dir, ".loopway").replace(/[^a-zA-Z0-9]/g, "-"));

async function main() {
  const { values } = parseArgs({
    options: { dir: { type: "string" }, force: { type: "boolean" }, reset: { type: "boolean" } },
  });
  const dir = resolve(process.env.INIT_CWD || process.cwd(), values.dir ?? join(CHECKOUT, "scratch"));
  await mkdir(join(dir, ".loopway"), { recursive: true });
  const project = await realpath(dir); // what `loopway` sees as its cwd, and so what its state is filed under

  for (const [file, text] of Object.entries(BOTS)) {
    console.log(await writeBot(join(project, ".loopway", file), text, values.force));
  }
  console.log(syncSandbox(join(project, "sandbox")));
  if (values.reset) console.log(await resetState(project));

  const run = onPath("loopway") ? "loopway" : `node ${join(CHECKOUT, "packages/cli/dist/index.js")}`;
  console.log(`\nNext: cd ${project} && ${run}`);
}

/** Writes a bot file, unless it exists with edits in it and `force` isn't set. Says which. */
async function writeBot(path, text, force) {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === text) return `unchanged  ${path}`;
  if (current !== undefined && !force) return `kept       ${path} (it has your edits; --force puts the default back)`;
  await writeFile(path, text);
  return `${current === undefined ? "wrote" : "reset"}      ${path}`;
}

/** Clones the sandbox into `path`, or fast-forwards the clone that is there. */
function syncSandbox(path) {
  const remote = process.env.LOOPWAY_SANDBOX_REMOTE;
  try {
    if (existsSync(join(path, ".git"))) {
      execFileSync("git", ["-C", path, "pull", "--ff-only", "--quiet"], { stdio: "pipe" });
      return `updated    ${path}`;
    }
    if (remote) execFileSync("git", ["clone", "--quiet", remote, path], { stdio: "pipe" });
    else execFileSync("gh", ["repo", "clone", SANDBOX, path, "--", "--quiet"], { stdio: "pipe" });
    return `cloned     ${path}`;
  } catch (err) {
    throw new Error(`could not sync ${path}: ${String(err.stderr ?? err.message).trim()}`, { cause: err });
  }
}

/** Forgets this project's threads and cursors, and nothing of any other project's. */
async function resetState(project) {
  const state = stateDirOf(process.env.LOOPWAY_HOME || join(homedir(), ".loopway"), project);
  await rm(state, { recursive: true, force: true });
  return `cleared    ${state}`;
}

function onPath(name) {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

main().catch((err) => {
  console.error(`init-scratch: ${err.message}`);
  process.exit(1);
});
