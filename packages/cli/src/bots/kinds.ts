import { threadPrompt } from "./agent.js";
import { GITHUB_RULES, type Rule } from "./routing.js";

/** The preset a bot of some `kind` starts from. The server stores any kind; the CLI knows these. */
export interface BotKind {
  /** The assign rules a new version starts with (see routing.ts). */
  rules: Rule[];
  /** The instructions a new session starts with. */
  prompt(): Promise<string>;
}

export const BOT_KINDS: Record<string, BotKind> = {
  "github-threads": { rules: GITHUB_RULES, prompt: threadPrompt },
};
