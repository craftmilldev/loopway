import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the CLI keeps its state. Tests pass their own dir; everything else uses ~/.loopway. */
export const defaultConfigDir = () => join(homedir(), ".loopway");

/** ~/.loopway/config.json */
export interface Config {
  api_url: string;
  api_key: string;
  /** Where product metrics go; Craftmill's shared proxy (https://a.craftmill.dev/api/ingest) when unset. Set it to send straight to PostHog (https://us.i.posthog.com), EU or self-hosted. */
  posthog_host?: string;
  /** Whether the CLI updates itself from GitHub releases. On unless this is false (or LOOPWAY_NO_UPDATE is set). */
  auto_update?: boolean;
}

/** The shared PostHog proxy every Craftmill product sends events through. */
const POSTHOG_PROXY = "https://a.craftmill.dev/api/ingest";

/** Used for anything neither the environment nor config.json sets. */
const DEFAULTS = { api_url: "https://loopway.craftmill.dev" };

export const configPath = (dir: string) => join(dir, "config.json");

/**
 * The settings commands should use: LOOPWAY_API_URL / LOOPWAY_API_KEY / POSTHOG_HOST, then config.json, then DEFAULTS.
 * The env vars let CI and scripts run without `loopway login`. There's no default key.
 */
export async function loadConfig(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  api_url: string;
  api_key?: string;
  posthog_host: string;
  auto_update: boolean;
}> {
  const file = await readConfig(dir);
  const api_url = env.LOOPWAY_API_URL || file?.api_url || DEFAULTS.api_url;
  return {
    api_url,
    api_key: env.LOOPWAY_API_KEY || file?.api_key,
    // Metrics go through Craftmill's shared PostHog proxy unless pointed elsewhere.
    posthog_host: env.POSTHOG_HOST || file?.posthog_host || POSTHOG_PROXY,
    auto_update: !(env.LOOPWAY_NO_UPDATE && env.LOOPWAY_NO_UPDATE !== "0") && file?.auto_update !== false,
  };
}

/** loadConfig, for commands that can't run without a key. */
export async function resolveAuth(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const { api_url, api_key } = await loadConfig(dir, env);
  if (!api_key) throw new NotLoggedInError();
  return { api_url, api_key };
}

/** Just config.json, without env or defaults; everything else should go through loadConfig. */
async function readConfig(dir: string): Promise<Partial<Config> | undefined> {
  const raw = await readJson(configPath(dir));
  if (!raw || typeof raw !== "object") return undefined;
  const { api_url, api_key, posthog_host, auto_update } = raw as Partial<Config>;
  return {
    api_url: typeof api_url === "string" ? api_url : undefined,
    api_key: typeof api_key === "string" ? api_key : undefined,
    posthog_host: typeof posthog_host === "string" && posthog_host ? posthog_host : undefined,
    auto_update: typeof auto_update === "boolean" ? auto_update : undefined,
  };
}

/**
 * Saves the settings it's given, keeping anything else config.json already has.
 * The key is optional so `loopway config update` can set the URL before `loopway login`.
 */
export async function writeConfig(
  dir: string,
  config: {
    api_url: string;
    api_key?: string;
    posthog_host?: string;
    auto_update?: boolean;
  },
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

/** Writes owner-only (0600 file in a 0700 dir): these files hold the API key. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600); // mode only applies on create; tighten files that already existed
}
