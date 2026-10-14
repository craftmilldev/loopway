import type { Context } from "hono";

export const CLI_VERSION_HEADER = "x-loopway-cli-version";

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
