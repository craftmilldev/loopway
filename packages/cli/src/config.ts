import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.loopway`, or `$LOOPWAY_HOME`. Holds config.json and the state files. */
export const loopwayHome = (env: NodeJS.ProcessEnv = process.env) => env.LOOPWAY_HOME || join(homedir(), ".loopway");

/** The `github` block of `~/.loopway/config.json`: the bot user's credentials. Everything else in the file is ignored. */
export interface GitHubConfig {
  token?: string;
  name?: string;
  email?: string;
}

export async function loadGitHubConfig(home: string): Promise<GitHubConfig> {
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
  const github = (raw as { github?: Record<string, unknown> } | null)?.github;
  if (!github || typeof github !== "object") return {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { token: str(github.token), name: str(github.name), email: str(github.email) };
}
