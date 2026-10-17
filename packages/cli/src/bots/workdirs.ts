import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJson } from "../config.js";
import { UsageError } from "../context.js";

/** The file in the directory `loopway bots run` starts in that gives bots their own working directories. */
export const WORKDIRS_FILE = "loopway.json";

/**
 * Bot name → the absolute directory its sessions run in, from `<dir>/loopway.json`:
 * `{"bots": {"<name>": {"cwd": "path/relative/to/dir"}}}`. No file means no entries. A bot that isn't listed, or
 * whose `cwd` is `.`, runs in `dir` like before. A file that doesn't fit, or names a directory that isn't there,
 * is a usage error, so a typo stops the runner at startup rather than failing a session later.
 */
export async function loadWorkdirs(dir: string): Promise<Map<string, string>> {
  const path = join(dir, WORKDIRS_FILE);
  let raw: unknown;
  try {
    raw = await readJson(path);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const out = new Map<string, string>();
  if (raw === undefined) return out;
  const bots = (raw as { bots?: unknown })?.bots;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || bots === undefined) return out;
  if (!bots || typeof bots !== "object" || Array.isArray(bots))
    throw new UsageError(`${path}: "bots" must be an object of {"<bot name>": {"cwd": "<directory>"}}`);
  for (const [name, entry] of Object.entries(bots as Record<string, unknown>)) {
    const cwd = (entry as { cwd?: unknown })?.cwd;
    if (!entry || typeof entry !== "object" || typeof cwd !== "string" || !cwd)
      throw new UsageError(`${path}: bot "${name}" needs a "cwd" string`);
    const full = resolve(dir, cwd);
    const info = await stat(full).catch(() => undefined);
    if (!info?.isDirectory()) throw new UsageError(`${path}: bot "${name}": ${full} is not a directory`);
    out.set(name, full);
  }
  return out;
}
