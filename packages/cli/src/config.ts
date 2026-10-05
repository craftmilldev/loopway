import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the CLI keeps its state. Tests pass their own dir; everything else uses ~/.loopway. */
export const defaultConfigDir = () => join(homedir(), ".loopway");

/** ~/.loopway/config.json */
export interface Config {
  api_url: string;
  api_key: string;
}

/** Used for anything neither the environment nor config.json sets. */
const DEFAULTS = { api_url: "http://localhost:3000" };

export const configPath = (dir: string) => join(dir, "config.json");

/**
 * The settings commands should use: LOOPWAY_API_URL / LOOPWAY_API_KEY, then config.json, then DEFAULTS.
 * The env vars let CI and scripts run without `loopway config`. There's no default key.
 */
export async function loadConfig(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ api_url: string; api_key?: string }> {
  const file = await readConfig(dir);
  return {
    api_url: env.LOOPWAY_API_URL || file?.api_url || DEFAULTS.api_url,
    api_key: env.LOOPWAY_API_KEY || file?.api_key,
  };
}

/** loadConfig, for commands that can't run without a key. */
export async function resolveAuth(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const { api_url, api_key } = await loadConfig(dir, env);
  if (!api_key) throw new NotConfiguredError();
  return { api_url, api_key };
}

/** Just config.json, without env or defaults; everything else should go through loadConfig. */
async function readConfig(dir: string): Promise<Config | undefined> {
  const raw = await readJson(configPath(dir));
  if (!raw || typeof raw !== "object") return undefined;
  const { api_url, api_key } = raw as Partial<Config>;
  return typeof api_url === "string" && typeof api_key === "string" ? { api_url, api_key } : undefined;
}

export async function writeConfig(dir: string, config: Config): Promise<void> {
  await writeJson(configPath(dir), { ...config, api_url: config.api_url.replace(/\/+$/, "") });
}

export async function clearConfig(dir: string): Promise<boolean> {
  const existed = (await readJson(configPath(dir))) !== undefined;
  await rm(configPath(dir), { force: true });
  return existed;
}

export class NotConfiguredError extends Error {
  constructor() {
    super("No API key configured. Run `loopway config` (or set LOOPWAY_API_KEY).");
  }
}

// ---------- files ----------

export async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

/** Writes owner-only (0600 file in a 0700 dir): these files hold the API key and lock tokens. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600); // mode only applies on create; tighten files that already existed
}
