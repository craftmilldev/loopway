import { spawn } from "node:child_process";
import { MANAGER_CHANGE_COMMANDS } from "@loopway/presets";

export type ChangeKind = "create" | "update" | "delete";

/** A change the manager proposed: the exact command, the files it names, and what it does. */
export interface Proposal {
  /** The command line as the manager wrote it, which is also what the user is shown and approves. */
  command: string;
  /** The words after `loopway`. */
  args: string[];
  /** The text behind each `@prompt` / `@rules` placeholder in the command. */
  files: Record<string, string>;
  kind: ChangeKind;
  target: "bot" | "inbox";
  /** The bot or inbox it changes, if the command names one. */
  name?: string;
  /** One line on what approving it does. */
  effect: string;
}

export type Parsed = { ok: true; proposal: Proposal } | { ok: false; reason: ParseFailure; text: string };
export type ParseFailure = "unparseable" | "not_allowed";

/** The files a command may read: only text the manager wrote in the proposal, never a path on the user's disk. */
const PLACEHOLDERS: Record<string, string> = { "--prompt-file": "@prompt", "--rules-file": "@rules" };

/** Options that take a path; anything but a placeholder for them is refused. */
const PATH_OPTIONS = ["--schema", "--config", "--message-file", ...Object.keys(PLACEHOLDERS)];

/** Splits a command line into words, as a shell would for quotes but without expanding anything; undefined if it isn't one plain command. */
export function tokenize(line: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && /["\\]/.test(line[i + 1] ?? "")) word = (word ?? "") + line[++i];
      else word = (word ?? "") + c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (/[;&|<>`$()\\]/.test(c)) {
      return undefined;
    } else word = (word ?? "") + c;
  }
  if (quote) return undefined;
  if (word !== undefined) words.push(word);
  return words;
}

/** The `loopway-change` blocks in a reply: the text between the fences (a longer fence can hold shorter ones). */
export function changeBlocks(text: string): string[] {
  return [...text.matchAll(/^(`{3,})loopway-change[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm)].map((m) => m[2]!);
}

/** Reads one proposal block: the command on its first line, then `@prompt` / `@rules` sections with the files' text. */
export function parseProposal(block: string): Parsed {
  const [first = "", ...rest] = block.trim().split("\n");
  const command = first.trim();
  const sections: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of rest) {
    if (line === "@prompt" || line === "@rules") current = sections[line] = [];
    else current?.push(line);
  }
  const files = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join("\n").trim() + "\n"]));

  const words = tokenize(command);
  if (!words?.length || words[0] !== "loopway")
    return refuse("unparseable", `Not one plain \`loopway\` command: ${command || "(empty)"}`);
  const args = words.slice(1);
  const spec = MANAGER_CHANGE_COMMANDS.find(([group, verb]) => args[0] === group && args[1] === verb);
  if (!spec) return refuse("not_allowed", `The manager may not run \`${command}\`.`);

  // Options that read a file may only name what the manager wrote into this proposal.
  const used = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const [flag, inline] = args[i]!.split(/=(.*)/s);
    if (!PATH_OPTIONS.includes(flag!)) continue;
    const value = inline ?? args[++i];
    const wanted = PLACEHOLDERS[flag!];
    if (!wanted || value !== wanted)
      return refuse(
        "not_allowed",
        `${flag} may only be given ${wanted ?? "@prompt or @rules"}, the text in the proposal.`,
      );
    if (!(value in files)) return refuse("unparseable", `The proposal names ${value} but has no ${value} section.`);
    used.add(value);
  }
  for (const key of Object.keys(files))
    if (!used.has(key)) return refuse("unparseable", `The proposal has a ${key} section no option uses.`);

  const [group, verb] = spec;
  const target = group === "bots" ? "bot" : "inbox";
  const kind: ChangeKind = verb === "create" ? "create" : verb === "delete" ? "delete" : "update";
  // The bot is the word right after the verb; anywhere else a non-dash word could be an option's value.
  const name =
    group === "bots" && verb !== "create"
      ? args[2]?.startsWith("-")
        ? undefined
        : args[2]
      : optionValue(args, "--name");
  const label = name ? ` "${name}"` : "";
  const effect =
    kind === "create"
      ? `Creates the ${target}${label}.`
      : kind === "delete"
        ? `Deletes the ${target}${label}. This cannot be undone.`
        : verb === "edit"
          ? `Saves a new version of the ${target}${label}'s ${["prompt", "rules"].filter((n) => files[`@${n}`] !== undefined).join(" and ")}.`
          : `Changes the ${target}${label}.`;
  return { ok: true, proposal: { command, args, files, kind, target, name, effect } };
}

/** The proposal as the manager wrote it in a block: the command, then its files under `@prompt` / `@rules`. */
export const proposalBlock = (p: Pick<Proposal, "command" | "files">): string =>
  [p.command, ...Object.entries(p.files).map(([section, text]) => `${section}\n${text}`)].join("\n");

/** What an approval is for: this command and this file text, exactly. */
export const approvalKey = (p: Pick<Proposal, "command" | "files">): string => JSON.stringify([p.command, p.files]);

const refuse = (reason: ParseFailure, text: string): Parsed => ({ ok: false, reason, text });

function optionValue(args: string[], flag: string): string | undefined {
  const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (i < 0) return undefined;
  return args[i]!.startsWith(`${flag}=`) ? args[i]!.slice(flag.length + 1) : args[i + 1];
}

/** What running a command gave back. */
export interface CommandResult {
  code: number;
  output: string;
}

/** Runs `loopway <args>` as this same CLI, without a shell, and returns what it printed. */
export function runLoopway(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1]!, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => resolve({ code: 1, output: err.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: output.trim() });
    });
  });
}
