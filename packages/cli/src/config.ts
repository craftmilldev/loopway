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

export const configPath = (dir: string) => join(dir, "config.json");

export async function readConfig(dir: string): Promise<Config | undefined> {
  const raw = await readJson(configPath(dir));
  if (!raw || typeof raw !== "object") return undefined;
  const { api_url, api_key } = raw as Partial<Config>;
  return typeof api_url === "string" && typeof api_key === "string" ? { api_url, api_key } : undefined;
}

export async function writeConfig(dir: string, config: Config): Promise<void> {
  await writeJson(configPath(dir), config);
}

export async function clearConfig(dir: string): Promise<boolean> {
  const existed = (await readJson(configPath(dir))) !== undefined;
  await rm(configPath(dir), { force: true });
  return existed;
}

/**
 * The credentials a command should use: LOOPWAY_API_URL / LOOPWAY_API_KEY override the config file,
 * so CI and scripts can run without `loopway login`.
 */
export async function resolveAuth(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const file = await readConfig(dir);
  const api_url = env.LOOPWAY_API_URL || file?.api_url;
  const api_key = env.LOOPWAY_API_KEY || file?.api_key;
  if (!api_url || !api_key) throw new NotLoggedInError();
  return { api_url, api_key };
}

export class NotLoggedInError extends Error {
  constructor() {
    super("Not logged in. Run `loopway login` (or set LOOPWAY_API_URL and LOOPWAY_API_KEY).");
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
