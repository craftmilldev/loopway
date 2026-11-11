#!/usr/bin/env node
// Sets up a scratch project whose bots watch the sandbox repo: `npm run init-scratch [-- --dir <path>] [--force] [--reset]`.
// Plain Node, no dependencies. See AGENTS.md and docs/developing.md.
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SANDBOX = "craftmilldev/loopway-sandbox";
const CHECKOUT = resolve(fileURLToPath(import.meta.url), "../..");

const bot = (on, prompt) => `---\nrepos: [${SANDBOX}]\non: ${on}\nmodel: sonnet\n---\n\n${prompt}\n`;
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
  const here = await realpath(process.env.INIT_CWD || process.cwd());
  const dir = resolve(here, values.dir ?? join(CHECKOUT, "scratch"));
  await mkdir(join(dir, ".loopway"), { recursive: true });
  const project = await realpath(dir); // what `loopway` sees as its cwd, and so what its state is filed under
  const shown = (path) => relative(here, path) || ".";

  for (const [file, text] of Object.entries(BOTS)) {
    console.log(await writeBot(join(project, ".loopway", file), text, values.force, shown));
  }
  if (values.reset) console.log(await resetState(project));
}

/** Writes a bot file, unless it exists with edits in it and `force` isn't set. Says which. */
async function writeBot(path, text, force, shown) {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === text) return `unchanged  ${shown(path)}`;
  if (current !== undefined && !force)
    return `kept       ${shown(path)} (it has your edits; --force puts the default back)`;
  await writeFile(path, text);
  return `${current === undefined ? "created   " : "reset     "} ${shown(path)}`;
}

/** Forgets this project's threads and cursors, and nothing of any other project's. */
async function resetState(project) {
  const state = stateDirOf(process.env.LOOPWAY_HOME || join(homedir(), ".loopway"), project);
  await rm(state, { recursive: true, force: true });
  return `cleared    ${state.replace(homedir(), "~")}`;
}

main().catch((err) => {
  console.error(`init-scratch: ${err.message}`);
  process.exit(1);
});
