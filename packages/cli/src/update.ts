import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig, readJson, writeJson } from "./config.js";
import { UsageError, type Context } from "./context.js";
import { CLI_VERSION } from "./version.js";

const REPO = "craftmilldev/loopway";
/** How long a lookup of the latest release is trusted, so commands don't each hit GitHub. */
const CHECK_TTL_MS = 10 * 60 * 1000;
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

/** Whether this CLI updates itself: installed from a release, and not turned off (LOOPWAY_NO_UPDATE or `loopway config update --auto-update off`). */
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
 * The newest release's version, from GitHub or, within ten minutes of the last lookup, from ~/.loopway/update-check.json.
 * Undefined when it can't be found (offline, rate limited): a failed lookup is remembered for the same ten minutes so
 * an offline machine doesn't wait on it every command. `force` skips the cached answer; `fresh` also refuses the last known one when the lookup fails.
 */
async function latestVersion(
  ctx: Context,
  force: boolean,
  deps: UpdateDeps,
  fresh = false,
): Promise<string | undefined> {
  const path = join(ctx.configDir, "update-check.json");
  const cached = await readCache(path);
  if (!force && cached && deps.now() - cached.checked_at < CHECK_TTL_MS) return cached.latest;
  let latest = cached?.latest;
  let looked = false;
  try {
    // The repo's latest release is the CLI's only while release-cli.yml is the one thing that publishes releases here
    // (as install.sh also assumes); a release of anything else would hide newer CLI ones.
    const res = await (ctx.fetch ?? fetch)(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "loopway-cli" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (res.ok) {
      looked = true;
      latest = releaseVersion(((await res.json()) as { tag_name?: string }).tag_name ?? "") ?? latest;
    }
  } catch {
    // Offline or slow: keep what we knew.
  }
  await writeJson(path, { checked_at: deps.now(), latest }).catch(() => {});
  // `fresh`: the caller wants GitHub's answer, not the last one known.
  return fresh && !looked ? undefined : latest;
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

/**
 * Runs this same command again, on whatever is installed now. `mark` is what the new process finds in LOOPWAY_UPDATED.
 * Where Node can (process.execve, 22.15+ and 23.11+, not on Windows) the new version takes over this process, so a
 * runner that updates many times is still one process. Otherwise this one waits on a child and exits with its status.
 */
export function reexec(mark = "1", proc: Pick<typeof process, "execve"> = process): never {
  const args = [...process.execArgv, ...process.argv.slice(1)];
  const env = { ...process.env, [UPDATED_ENV]: mark };
  try {
    proc.execve?.(process.execPath, [process.execPath, ...args], env);
  } catch {
    // Not allowed here (a worker, an unsupported platform): wait on a child instead.
  }
  const res = spawnSync(process.execPath, args, { stdio: "inherit", env });
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
  const installed = await installRelease(ctx, version, deps, log);
  // Recorded before the hand-off: an exec replaces this process, so nothing after it would run.
  await ctx.metrics?.capture("cli_self_update", {
    outcome: installed ? "installed" : "install_failed",
    handoff: typeof process.execve === "function" ? "exec" : "child",
  });
  reexec(installed ? "1" : "failed");
}

/** After the server turned this version away (`cli_outdated`): updates now, whatever the last lookup said, and runs the command again. */
export async function updateAfterOutdated(ctx: Context, deps: UpdateDeps = defaultDeps): Promise<void> {
  if (ctx.env[UPDATED_ENV]) return;
  const version = await availableUpdate(ctx, { force: true }, deps);
  if (version && (await installRelease(ctx, version, deps))) reexec();
}

/**
 * `loopway update`: installs the newest release now, whatever the cached lookup or the auto-update setting says.
 * A copy that is already the newest is left alone unless `force` reinstalls it.
 */
export async function updateCommand(
  ctx: Context,
  opts: { force?: boolean } = {},
  deps: UpdateDeps = defaultDeps,
): Promise<void> {
  const done = (outcome: string) => void ctx.metrics?.capture("cli_update", { outcome, force: !!opts.force });
  if (!deps.installed) {
    done("not_installed");
    throw new UsageError(
      "This loopway runs from a git checkout, so it can't update itself. Run `npm run update` there.",
    );
  }
  const latest = await latestVersion(ctx, true, deps, true);
  if (!latest) {
    done("lookup_failed");
    throw new Error("Could not find the latest loopway release (offline or rate limited by GitHub). Try again later.");
  }
  if (!isNewer(latest, CLI_VERSION) && !opts.force) {
    done("current");
    ctx.out(`loopway ${CLI_VERSION} is the newest release.`);
    return;
  }
  if (!(await installRelease(ctx, latest, deps, ctx.out))) {
    done("install_failed");
    process.exitCode = 1;
    return;
  }
  done("updated");
  ctx.out(`loopway ${latest} installed.`);
}
