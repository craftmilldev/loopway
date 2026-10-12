import { readFile } from "node:fs/promises";
import type { BotKind } from "../../kinds.js";
import { GITHUB_THREADS_RULES } from "./rules.js";

/** prompt.md next to this file; the build copies it to dist/ beside the compiled code. */
const PROMPT_FILE = new URL("prompt.md", import.meta.url);

/** The instructions every session starts with. */
export async function threadPrompt(): Promise<string> {
  return (await readFile(PROMPT_FILE, "utf8")).trimEnd();
}

/** The default bot: one session per issue or PR thread. A new `github-threads` bot starts with this prompt and these rules. */
export const githubThreads: BotKind = { prompt: threadPrompt, rules: GITHUB_THREADS_RULES };
