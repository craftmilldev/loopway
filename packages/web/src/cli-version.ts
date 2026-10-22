import type { Context } from "hono";

export const CLI_VERSION_HEADER = "x-loopway-cli-version";

/**
 * The oldest CLI release the server accepts. A PR that makes the server reject something the current CLI release
 * sends raises this, in the same diff, to the release that includes the matching CLI change. `MIN_CLI_VERSION` can
 * only raise the minimum above it.
 */
export const MIN_CLI_VERSION_FLOOR = "0.3.37";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** The CLI version a request names, `none` if it names no CLI and `unknown` if it isn't a version. Safe as a metric property. */
export function cliVersion(c: Context): string {
  const raw = c.req.header(CLI_VERSION_HEADER);
  if (raw === undefined) return "none";
  const m = SEMVER.exec(raw.trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}` : "unknown";
}

/** Whether `version` (x.y.z) is older than `min`. A `min` that isn't a version turns nobody away. */
export function olderThan(version: string, min: string): boolean {
  const a = SEMVER.exec(version);
  const b = SEMVER.exec(min.trim());
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
  }
  return false;
}

/** The minimum CLI version to enforce: the newer of the floor in code and `MIN_CLI_VERSION` from the environment. */
export function minCliVersion(env: string | undefined, floor = MIN_CLI_VERSION_FLOOR): string {
  const fromEnv = env?.trim();
  return fromEnv && olderThan(floor, fromEnv) ? fromEnv : floor;
}
