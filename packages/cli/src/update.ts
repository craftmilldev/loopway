import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig, readJson, writeJson } from "./config.js";
import type { Context } from "./context.js";
import { CLI_VERSION } from "./version.js";

const REPO = "craftmilldev/loopway";
/** How long a lookup of the latest release is trusted, so commands don't each hit GitHub. */
const CHECK_TTL_MS = 60 * 60 * 1000;
/** A lookup that takes longer than this is treated as a failed one: the command goes ahead on this version. */
const LOOKUP_TIMEOUT_MS = 3000;
/** Set on the process a self-update starts, so it doesn't update again before running the command. */
const UPDATED_ENV = "LOOPWAY_UPDATED";

/** Things tests replace. */
export interface UpdateDeps {
  /** Whether this CLI was installed from a release (npm i -g), as opposed to run from a git checkout. */
  installed: boolean;
  /** The other packages (`rules` for @loopway/rules) a downloaded CLI tarball depends on, which are released alongside it. */
  needs: (cliTarball: string) => Promise<string[]>;
  /** Installs the given tarballs globally. */
  install: (files: string[]) => Promise<void>;
  now: () => number;
}

const run = promisify(execFile);

export const defaultDeps: UpdateDeps = {
  // An installed copy lives under a node_modules directory; a checkout (tsx or dist) doesn't.
  installed: fileURLToPath(import.meta.url)
    .split(sep)
    .includes("node_modules"),
  needs: async (cli) => {
    const { stdout } = await run("tar", ["-xzOf", cli, "package/package.json"]);
    const { dependencies = {} } = JSON.parse(stdout) as { dependencies?: Record<string, string> };
    return Object.keys(dependencies)
      .filter((name) => name.startsWith("@loopway/"))
      .map((name) => name.slice("@loopway/".length));
  },
  install: async (files) => void (await run("npm", ["install", "-g", ...files], { timeout: 5 * 60 * 1000 })),
  now: Date.now,
};

/** Whether this CLI updates itself: installed from a release, and not turned off (LOOPWAY_NO_UPDATE or `loopway config --auto-update off`). */
export async function updatesEnabled(ctx: Context, deps: UpdateDeps = defaultDeps): Promise<boolean> {
  return deps.installed && (await loadConfig(ctx.configDir, ctx.env)).auto_update;
}

/** The version of `cli-v<x.y.z>`, or undefined for any other tag. */
export function releaseVersion(tag: string): string | undefined {
  return /^cli-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
}

/** Whether version `a` is newer than `b`; both are x.y.z. */
export function isNewer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!;
  return false;
}

/**
 * The newest release's version, from GitHub or, within an hour of the last lookup, from ~/.loopway/update-check.json.
 * Undefined when it can't be found (offline, rate limited): a failed lookup is remembered for the same hour so
 * an offline machine doesn't wait on it every command. `force` skips the cached answer.
 */
async function latestVersion(ctx: Context, force: boolean, deps: UpdateDeps): Promise<string | undefined> {
  const path = join(ctx.configDir, "update-check.json");
  const cached = await readCache(path);
  if (!force && cached && deps.now() - cached.checked_at < CHECK_TTL_MS) return cached.latest;
  let latest = cached?.latest;
  try {
    // The repo's latest release is the CLI's only while release-cli.yml is the one thing that publishes releases here
    // (as install.sh also assumes); a release of anything else would hide newer CLI ones.
    const res = await (ctx.fetch ?? fetch)(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "loopway-cli" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (res.ok) latest = releaseVersion(((await res.json()) as { tag_name?: string }).tag_name ?? "") ?? latest;
  } catch {
    // Offline or slow: keep what we knew.
  }
  await writeJson(path, { checked_at: deps.now(), latest }).catch(() => {});
  return latest;
}

async function readCache(path: string): Promise<{ checked_at: number; latest?: string } | undefined> {
  const raw = await readJson(path).catch(() => undefined);
  if (!raw || typeof raw !== "object") return undefined;
  const { checked_at, latest } = raw as { checked_at?: unknown; latest?: unknown };
  if (typeof checked_at !== "number") return undefined;
  return { checked_at, latest: typeof latest === "string" ? latest : undefined };
}

/** The version a newer release has, if updates are on and there is one. */
export async function availableUpdate(
  ctx: Context,
  opts: { force?: boolean } = {},
  deps: UpdateDeps = defaultDeps,
): Promise<string | undefined> {
  // "failed": the process before this one couldn't install this very update, so don't try again until restarted.
  if (ctx.env[UPDATED_ENV] === "failed" || !(await updatesEnabled(ctx, deps))) return undefined;
  const latest = await latestVersion(ctx, opts.force ?? false, deps);
  return latest && isNewer(latest, CLI_VERSION) ? latest : undefined;
}

/** Downloads release `version` and installs it over this one. False, with a warning, if that fails: the current version keeps working. */
export async function installRelease(
  ctx: Context,
  version: string,
  deps: UpdateDeps = defaultDeps,
  log: (text: string) => void = console.error,
): Promise<boolean> {
  log(`Updating loopway ${CLI_VERSION} → ${version}…`);
  const dir = await mkdtemp(join(tmpdir(), "loopway-update-"));
  try {
    const download = async (name: string) => {
      const url = `https://github.com/${REPO}/releases/download/cli-v${version}/loopway-${name}.tgz`;
      const res = await (ctx.fetch ?? fetch)(url);
      if (!res.ok) throw new Error(`could not download ${url} (${res.status})`);
      const file = join(dir, `loopway-${name}.tgz`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      return file;
    };
    // The CLI says what else it needs: its @loopway/* dependencies are released next to it, as loopway-<name>.tgz.
    const cli = await download("cli");
    const needs = await deps.needs(cli);
    await deps.install([...(await Promise.all(needs.map(download))), cli]);
    return true;
  } catch (err) {
    log(`Could not update loopway: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs this same command again, on whatever is installed now, and exits with its status. `mark` is what the new process finds in LOOPWAY_UPDATED. */
export function reexec(mark = "1"): never {
  const res = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, [UPDATED_ENV]: mark },
  });
  process.exit(res.status ?? 1);
}

/**
 * Before a command: installs a newer release, if updates are on and there is one, and runs the command again on it.
 * Does nothing in the process a self-update started, and never stops a command from running.
 */
export async function updateBeforeCommand(ctx: Context, deps: UpdateDeps = defaultDeps): Promise<void> {
  if (ctx.env[UPDATED_ENV]) return;
  const version = await availableUpdate(ctx, {}, deps);
  if (version && (await installRelease(ctx, version, deps))) reexec();
}

/** Installs release `version` and runs this command again; if the install fails, on this version with updates paused. */
export async function applyUpdate(
  ctx: Context,
  version: string,
  log: (text: string) => void = console.error,
  deps: UpdateDeps = defaultDeps,
): Promise<never> {
  reexec((await installRelease(ctx, version, deps, log)) ? "1" : "failed");
}

/** After the server turned this version away (`cli_outdated`): updates now, whatever the last lookup said, and runs the command again. */
export async function updateAfterOutdated(ctx: Context, deps: UpdateDeps = defaultDeps): Promise<void> {
  if (ctx.env[UPDATED_ENV]) return;
  const version = await availableUpdate(ctx, { force: true }, deps);
  if (version && (await installRelease(ctx, version, deps))) reexec();
}
