import type { BotKind } from "../../kinds.js";
import { THREAD_PROMPT } from "./prompt.js";
import { GITHUB_THREADS_RULES } from "./rules.js";

/** The instructions every session starts with. */
export const threadPrompt = async (): Promise<string> => THREAD_PROMPT;

/** The default bot: one session per issue or PR thread. A new `github-threads` bot starts with this prompt and these rules. */
export const githubThreads: BotKind = { prompt: threadPrompt, rules: GITHUB_THREADS_RULES };
