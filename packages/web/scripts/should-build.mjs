// Vercel "Ignored Build Step" (packages/web/vercel.json `ignoreCommand`): exit 0 skips the build, exit 1 builds.
// Plain .mjs so it runs before `npm install`. It works out what web depends on each run (no fixed list): web plus
// every @loopway/* package reachable from its package.json, plus the root files the build reads, diffed against the
// last successful deploy (VERCEL_GIT_PREVIOUS_SHA, not HEAD^, so skipped merges followed by a web change build once).
//
// The web build runs DB migrations (scripts/build.ts); migrations live in packages/web, so a migration change builds.
// Everything web reads at build or run time must sit inside packages/web or come through an @loopway/* dependency.
// If web ever reads a file elsewhere in the repo, add it to ROOT_INPUTS (and keep AGENTS.md in step).
// When unsure (no previous SHA, unreadable package.json, git failure) it builds: an unneeded build is the worst case.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const WEB = "@loopway/web";
export const ROOT_INPUTS = [
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  ".npmrc",
  ".nvmrc",
  ".node-version",
];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// Package directories (relative to the repo root) web depends on, itself included, found from package.json files.
export function webClosure(root) {
  const dirByName = new Map();
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, "packages", entry.name, "package.json");
    if (existsSync(manifest)) dirByName.set(readJson(manifest).name, `packages/${entry.name}`);
  }
  if (!dirByName.has(WEB)) throw new Error(`no ${WEB} package under packages/`);

  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const pkg = readJson(join(root, dirByName.get(name), "package.json"));
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (!dep.startsWith("@loopway/")) continue;
        if (!dirByName.has(dep)) throw new Error(`${name} depends on ${dep}, which is not under packages/`);
        visit(dep);
      }
    }
  };
  visit(WEB);
  return [...seen].map((name) => dirByName.get(name)).sort();
}

// Returns { build, reason }. `git(...args)` runs git in the repo and returns stdout, throwing on failure.
export function decide({ root, previousSha, git }) {
  if (!previousSha) return { build: true, reason: "VERCEL_GIT_PREVIOUS_SHA is not set" };
  // Vercel runs the ignore command in its root directory (packages/web), and git resolves pathspecs against the
  // cwd, so every call is pinned to the repo root: from packages/web, `packages/web` would match nothing.
  const atRoot = (...args) => git("-C", root, ...args);
  try {
    const paths = [...webClosure(root), ...ROOT_INPUTS];
    try {
      atRoot("cat-file", "-e", `${previousSha}^{commit}`);
    } catch {
      atRoot("fetch", "--depth=1", "origin", previousSha);
    }
    const changed = atRoot("diff", "--name-only", previousSha, "HEAD", "--", ...paths)
      .split("\n")
      .filter(Boolean);
    if (changed.length) return { build: true, reason: `changed since ${previousSha}:\n${changed.join("\n")}` };
    return { build: false, reason: `no web inputs changed since ${previousSha} (watching ${paths.join(", ")})` };
  } catch (err) {
    return { build: true, reason: `could not tell what changed (${err.message})` };
  }
}

function main() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let decision;
  try {
    const root = git("rev-parse", "--show-toplevel").trim();
    decision = decide({ root, previousSha: process.env.VERCEL_GIT_PREVIOUS_SHA, git });
  } catch (err) {
    decision = { build: true, reason: `could not tell what changed (${err.message})` };
  }
  console.log(`${decision.build ? "Building" : "Skipping build"}: ${decision.reason}`);
  process.exit(decision.build ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
