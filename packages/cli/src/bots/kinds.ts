import type { BotRule } from "../client.js";
import { threadPrompt } from "./agent.js";
import { GITHUB_THREADS_RULES } from "./rules.js";

/** How `loopway bots run` runs a bot of some `kind`. The server stores any kind; the CLI runs these. */
export interface BotKind {
  /** The instructions a new session starts with. */
  prompt(): Promise<string>;
  /** The assign rules a new bot of this kind starts with (see route in rules.ts). */
  rules: BotRule[];
}

export const BOT_KINDS: Record<string, BotKind> = {
  "github-threads": { prompt: threadPrompt, rules: GITHUB_THREADS_RULES },
};
