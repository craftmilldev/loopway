import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { Subject } from "./source.js";

/** A test on a subject's labels. */
export type LabelExpr = string | LabelExpr[] | { and: LabelExpr[] } | { or: LabelExpr[] } | { not: LabelExpr };

/** A bot file, `.loopway/<name>.md`: YAML front matter for its rules, Markdown for its prompt. */
export interface Bot {
  name: string;
  /** `owner/name` of each repo the bot reads. */
  repos: string[];
  /** The kinds of subject that start a thread for this bot: `on: issue`, `on: pull_request`, or a list of both. */
  on: Subject["kind"][];
  /** The harness that runs its sessions. Only `claude` (Claude Code) for now. */
  harness: "claude";
  /** Passed to the harness as its model, like `sonnet`. Left out, the harness picks. */
  model?: string;
  /**
   * Which labels a subject needs for this bot to start a thread. Left out, any subject does.
   * A label name, `"!name"` (the label is absent), `{ and: [...] }`, `{ or: [...] }`, `{ not: x }`, or a bare list,
   * which is `and`.
   */
  labels?: LabelExpr;
  /**
   * Logins and `org/team` slugs whose issues, pull requests, comments and reviews this bot acts on, besides yours and
   * the bot user's, who are always trusted. Work still starts only on what is assigned to you.
   */
  trusted: string[];
  /** Tool patterns in Claude Code's permission syntax (`Bash(npm test:*)`) that pass without asking. */
  allow: string[];
  /** Tool patterns that are refused without asking. They win over `allow`. */
  deny: string[];
  /** Tool patterns that always go to the owner for a 👍/👎, even when auto mode or `allow` would let them through. `deny` wins over them. */
  ask: string[];
  /** The front matter as written. Keys this version doesn't know are kept and ignored. */
  rules: Record<string, unknown>;
  /** Used from a later slice on, when a bot runs a session. */
  prompt: string;
}

const KINDS = ["issue", "pull_request"];
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
  return {
    name,
    repos,
    on: parseOn(rules.on, where),
    harness: parseHarness(rules.harness, where),
    model: typeof rules.model === "string" ? rules.model : undefined,
    labels: parseLabels(rules.labels, where),
    trusted: parseTrusted(rules.trusted, where),
    allow: parsePatterns(rules.allow, "allow", where),
    deny: parsePatterns(rules.deny, "deny", where),
    ask: parsePatterns(rules.ask, "ask", where),
    rules,
    prompt: (match ? (match[2] ?? "") : text).trim(),
  };
}

function parsePatterns(raw: unknown, key: string, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string"))
    throw new Error(`${where}: "${key}" is a list of tool patterns, like ["Bash(npm test:*)"]`);
  return raw as string[];
}

const LABEL_HELP = `a label name, "!name", or and/or/not of those, like labels: { or: [bug, "!epic"] }`;

function parseLabels(raw: unknown, where: string): LabelExpr | undefined {
  if (raw === undefined) return undefined;
  return checkLabels(raw, where);
}

function checkLabels(raw: unknown, where: string): LabelExpr {
  const bad = () => new Error(`${where}: "labels" is ${LABEL_HELP}`);
  if (typeof raw === "string") {
    if (raw.replace(/^!/, "").trim() === "") throw bad();
    return raw;
  }
  if (Array.isArray(raw)) return raw.map((e) => checkLabels(e, where));
  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw);
    const [op, value] = entries[0] ?? [];
    if (entries.length !== 1) throw bad();
    if ((op === "and" || op === "or") && Array.isArray(value))
      return { [op]: value.map((e) => checkLabels(e, where)) } as LabelExpr;
    if (op === "not") return { not: checkLabels(value, where) };
  }
  throw bad();
}

/** Whether a subject with these labels passes a bot's `labels:`. No expression passes everything. Names ignore case. */
export function matchesLabels(expr: LabelExpr | undefined, labels: string[]): boolean {
  if (expr === undefined) return true;
  const have = new Set(labels.map((l) => l.toLowerCase()));
  const test = (e: LabelExpr): boolean => {
    if (typeof e === "string") {
      const negated = e.startsWith("!");
      return (
        have.has(
          e
            .slice(negated ? 1 : 0)
            .trim()
            .toLowerCase(),
        ) !== negated
      );
    }
    if (Array.isArray(e)) return e.every(test);
    if ("and" in e) return e.and.every(test);
    if ("or" in e) return e.or.some(test);
    return !test(e.not);
  };
  return test(expr);
}

const LOGIN = /^[\w-]+(?:\/[\w.-]+)?$/;

function parseTrusted(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const entry of list) {
    if (typeof entry !== "string" || !LOGIN.test(entry))
      throw new Error(`${where}: "trusted" is a list of GitHub logins and org/team slugs, like ["alice", "acme/devs"]`);
  }
  return list as string[];
}

function parseHarness(raw: unknown, where: string): Bot["harness"] {
  if (raw === undefined || raw === "claude") return "claude";
  throw new Error(`${where}: "harness: ${JSON.stringify(raw)}" is not one loopway runs; use claude`);
}
function parseOn(raw: unknown, where: string): Bot["on"] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  for (const kind of list) {
    if (!KINDS.includes(kind as string)) {
      throw new Error(`${where}: "on: ${String(kind)}" is not a kind of subject; use issue or pull_request`);
    }
  }
  return list as Bot["on"];
}

/** Every repo any bot reads, once each. */
export const reposOf = (bots: Bot[]): string[] => [...new Set(bots.flatMap((b) => b.repos))];
