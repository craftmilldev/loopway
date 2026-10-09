import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the CLI keeps its state. Tests pass their own dir; everything else uses ~/.loopway. */
export const defaultConfigDir = () => join(homedir(), ".loopway");

/** ~/.loopway/config.json */
export interface Config {
  api_url: string;
  api_key: string;
  /** The GitHub bot `loopway bots run` sessions act as. Set by `loopway config`; `login` keeps it. */
  github?: GithubBot;
}

/** A GitHub user account, and its token, for sessions to comment, push and commit as. */
export interface GithubBot {
  token: string;
  /** Author and committer of the bot's commits. */
  name: string;
  email: string;
}

/** Used for anything neither the environment nor config.json sets. */
const DEFAULTS = { api_url: "https://loopway.craftmill.dev" };

export const configPath = (dir: string) => join(dir, "config.json");

/**
 * The settings commands should use: LOOPWAY_API_URL / LOOPWAY_API_KEY, then config.json, then DEFAULTS.
 * The env vars let CI and scripts run without `loopway login`. There's no default key.
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
  if (!api_key) throw new NotLoggedInError();
  return { api_url, api_key };
}

/**
 * The GitHub bot for `loopway bots run`: LOOPWAY_GITHUB_TOKEN / LOOPWAY_GITHUB_NAME / LOOPWAY_GITHUB_EMAIL,
 * then config.json's `github`. Undefined when none of the three is set; an error when only some are.
 */
export async function loadGithubBot(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<GithubBot | undefined> {
  const file = await readGithubBot(dir);
  const token = env.LOOPWAY_GITHUB_TOKEN || file.token;
  const name = env.LOOPWAY_GITHUB_NAME || file.name;
  const email = env.LOOPWAY_GITHUB_EMAIL || file.email;
  if (!token && !name && !email) return undefined;
  if (!token || !name || !email) {
    throw new Error(
      "The GitHub bot needs a token, name and email: run `loopway config`, or set LOOPWAY_GITHUB_TOKEN/NAME/EMAIL.",
    );
  }
  return { token, name, email };
}

/** Just config.json's `github`, without env; any of the three may be missing. */
export async function readGithubBot(dir: string): Promise<Partial<GithubBot>> {
  const raw = await readJson(configPath(dir));
  const file = raw && typeof raw === "object" ? (raw as Partial<Config>).github : undefined;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { token: str(file?.token), name: str(file?.name), email: str(file?.email) };
}

/** Just config.json, without env or defaults; everything else should go through loadConfig. */
async function readConfig(dir: string): Promise<Partial<Config> | undefined> {
  const raw = await readJson(configPath(dir));
  if (!raw || typeof raw !== "object") return undefined;
  const { api_url, api_key } = raw as Partial<Config>;
  return {
    api_url: typeof api_url === "string" ? api_url : undefined,
    api_key: typeof api_key === "string" ? api_key : undefined,
  };
}

/**
 * Saves the settings it's given, keeping anything else config.json already has (like `github`).
 * The key is optional so `loopway config` can set the URL before `loopway login`.
 */
export async function writeConfig(
  dir: string,
  config: { api_url: string; api_key?: string; github?: GithubBot },
): Promise<void> {
  const existing = await readJson(configPath(dir));
  const rest = existing && typeof existing === "object" ? existing : {};
  await writeJson(configPath(dir), { ...rest, ...config, api_url: config.api_url.replace(/\/+$/, "") });
}

export async function clearConfig(dir: string): Promise<boolean> {
  const existed = (await readJson(configPath(dir))) !== undefined;
  await rm(configPath(dir), { force: true });
  return existed;
}

export class NotLoggedInError extends Error {
  constructor() {
    super("Not logged in. Run `loopway login` (or set LOOPWAY_API_KEY).");
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
