import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

/** A bot file, `.loopway/<name>.md`: YAML front matter for its rules, Markdown for its prompt. */
export interface Bot {
  name: string;
  /** `owner/name` of each repo the bot reads. */
  repos: string[];
  /** The front matter as written. Keys this version doesn't know are kept and ignored. */
  rules: Record<string, unknown>;
  /** Used from a later slice on, when a bot runs a session. */
  prompt: string;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** Reads every `.loopway/*.md` under `dir`. No folder means no bots. */
export async function loadBots(dir: string): Promise<Bot[]> {
  const folder = join(dir, ".loopway");
  let files: string[];
  try {
    files = (await readdir(folder)).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const bots: Bot[] = [];
  for (const file of files) {
    bots.push(parseBot(file.slice(0, -3), await readFile(join(folder, file), "utf8"), join(folder, file)));
  }
  return bots;
}

export function parseBot(name: string, text: string, where = `${name}.md`): Bot {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/.exec(text);
  let rules: Record<string, unknown> = {};
  if (match) {
    let parsed: unknown;
    try {
      parsed = parse(match[1] ?? "");
    } catch (err) {
      throw new Error(`${where}: the front matter is not valid YAML (${(err as Error).message.split("\n")[0]})`, {
        cause: err,
      });
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rules = parsed as Record<string, unknown>;
  }
  const raw = rules.repos;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const repos = list.map(String);
  for (const repo of repos) {
    if (!REPO.test(repo)) throw new Error(`${where}: "${repo}" is not a repo; write it as owner/name`);
  }
  return { name, repos, rules, prompt: (match ? (match[2] ?? "") : text).trim() };
}

/** Every repo any bot reads, once each. */
export const reposOf = (bots: Bot[]): string[] => [...new Set(bots.flatMap((b) => b.repos))];
