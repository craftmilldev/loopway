import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { abortableSleep } from "./poller.js";

const REPO = "craftmilldev/loopway";
/** How often a running loopway looks for a newer release. */
export const CHECK_EVERY_MS = 10 * 60_000;
/** A lookup slower than this counts as a failed one: loopway goes ahead on this version. */
const LOOKUP_TIMEOUT_MS = 3000;
/** Set on the process an update starts, to the version it installed, so that process doesn't try it again. */
export const UPDATED_ENV = "LOOPWAY_UPDATED";

const run = promisify(execFile);

/** Whether this copy was installed from a release (`npm i -g`), as opposed to run from a git checkout. */
export const installedFromRelease = () =>
  fileURLToPath(import.meta.url)
    .split(sep)
    .includes("node_modules");

/** The version of a `cli-v<x.y.z>` tag, or undefined for any other tag. */
export const releaseVersion = (tag: string) => /^cli-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];

/** Whether version `a` is newer than `b`. A pre-release (`2.0.0-alpha`) is older than its release. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => ({ n: v.split("-")[0]!.split(".").map(Number), pre: v.includes("-") });
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  return y.pre && !x.pre;
}

/** The newest release's version, or undefined when it can't be found (offline, rate limited, slow). */
export async function latestRelease(fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  try {
    // The repo's latest release is the CLI's: release-cli.yml is the one thing that makes releases here (as install.sh
    // also assumes).
    const res = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "loopway-cli" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return releaseVersion(((await res.json()) as { tag_name?: string }).tag_name ?? "");
  } catch {
    return undefined;
  }
}

/** Things tests replace. */
export interface InstallDeps {
  fetch?: typeof fetch;
  /** Installs the tarball globally. */
  install?: (file: string) => Promise<void>;
}

/** Downloads release `version` and installs it over this one. False, saying why, if that fails: this version keeps working. */
export async function installRelease(
  version: string,
  log: (message: string) => void,
  deps: InstallDeps = {},
): Promise<boolean> {
  const install =
    deps.install ?? (async (file) => void (await run("npm", ["install", "-g", file], { timeout: 300_000 })));
  const dir = await mkdtemp(join(tmpdir(), "loopway-update-"));
  try {
    const url = `https://github.com/${REPO}/releases/download/cli-v${version}/loopway-cli.tgz`;
    const res = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`could not download ${url} (${res.status})`);
    const file = join(dir, "loopway-cli.tgz");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    await install(file);
    return true;
  } catch (err) {
    log(`could not update loopway to ${version}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What `reexec` touches, so tests can stand in for it. */
export interface ReexecProc {
  execve?: typeof process.execve;
  spawn?: (file: string, args: string[], options: { stdio: "inherit"; env: NodeJS.ProcessEnv }) => ChildProcess;
  onSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
  exit?: (code: number) => never;
}

/**
 * Runs this same command again, on whatever is installed now; the new process finds `version` in LOOPWAY_UPDATED.
 * Where Node can (`process.execve`, 22.15+, not Windows) the new version takes over this process. Otherwise this one
 * stays as the parent of a child, passes SIGINT and SIGTERM on to it (so stopping the pid that was started stops the
 * new version too) and exits with its status.
 */
export function reexec(version: string, proc: ReexecProc = {}): Promise<never> {
  const args = [...process.execArgv, ...process.argv.slice(1)];
  const env = { ...process.env, [UPDATED_ENV]: version };
  try {
    const execve = "execve" in proc ? proc.execve : process.execve?.bind(process);
    execve?.(process.execPath, [process.execPath, ...args], env);
  } catch {
    // Not allowed here: wait on a child instead.
  }
  const child = (proc.spawn ?? spawn)(process.execPath, args, { stdio: "inherit", env });
  const onSignal = proc.onSignal ?? ((signal, handler) => void process.on(signal, handler));
  for (const signal of ["SIGINT", "SIGTERM"] as const) onSignal(signal, () => child.kill(signal));
  const exit = proc.exit ?? ((code: number): never => process.exit(code));
  // Never resolves: the process ends when the child does.
  return new Promise<never>(() => {
    child.on("exit", (code) => exit(code ?? 1));
  });
}

export interface WatchOptions {
  /** This version, and the one a past update installed (so a release that didn't take isn't retried every time). */
  current: string;
  tried?: string;
  latest: () => Promise<string | undefined>;
  signal: AbortSignal;
  /** Called with a newer version, once per version; the watch goes on after it returns. */
  found: (version: string) => Promise<void> | void;
  everyMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Looks for a newer release every `everyMs` until `signal` aborts, and hands each new one to `found`. */
export async function watchForUpdate(o: WatchOptions): Promise<void> {
  const sleep = o.sleep ?? abortableSleep;
  let tried = o.tried;
  while (!o.signal.aborted) {
    await sleep(o.everyMs ?? CHECK_EVERY_MS, o.signal);
    if (o.signal.aborted) return;
    const latest = await o.latest();
    if (!latest || !isNewer(latest, o.current) || (tried && !isNewer(latest, tried))) continue;
    tried = latest;
    await o.found(latest);
  }
}
