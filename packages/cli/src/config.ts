import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.loopway`, or `$LOOPWAY_HOME`. Holds config.json, the bot credentials, and each project's state (see `stateDir`). */
export const loopwayHome = (env: NodeJS.ProcessEnv = process.env) => env.LOOPWAY_HOME || join(homedir(), ".loopway");

/** The `github` block of `~/.loopway/config.json`: the bot user's credentials. Everything else in the file is ignored. */
export interface GitHubConfig {
  token?: string;
  name?: string;
  email?: string;
}

/** config.json parsed, or `{}` when there is none. */
async function readConfig(home: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(join(home, "config.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${join(home, "config.json")} is not valid JSON`);
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export async function loadGitHubConfig(home: string): Promise<GitHubConfig> {
  const github = (await readConfig(home)).github as Record<string, unknown> | undefined;
  if (!github || typeof github !== "object") return {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { token: str(github.token), name: str(github.name), email: str(github.email) };
}

/** Whether loopway updates itself: on unless `auto_update` is `false` in config.json or LOOPWAY_NO_UPDATE is set. */
export async function loadAutoUpdate(home: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.LOOPWAY_NO_UPDATE) return false;
  return (await readConfig(home)).auto_update !== false;
}

/**
 * Sets the `github` block of config.json and leaves every other key as it was. The file holds a token, so it is
 * written for you alone (0600), in a folder made if need be.
 */
export async function saveGitHubConfig(home: string, github: GitHubConfig): Promise<void> {
  const config = await readConfig(home);
  const block = { ...(config.github as Record<string, unknown> | undefined), ...github };
  await mkdir(home, { recursive: true });
  const path = join(home, "config.json");
  await writeFile(path, JSON.stringify({ ...config, github: block }, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600); // writeFile's mode only applies to a new file
}
