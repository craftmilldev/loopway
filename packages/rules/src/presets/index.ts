import type { BotRule } from "../index.js";
import { THREAD_PROMPT } from "./github-threads-prompt.js";
import { GITHUB_THREADS_RULES } from "./github-threads-rules.js";

/** A template for a new bot's first version. The bot doesn't remember which one it came from. */
export interface Preset {
  prompt: string;
  rules: BotRule[];
}

export const PRESETS: Record<string, Preset> = {
  /** One session per issue or PR thread. */
  "github-threads": { prompt: THREAD_PROMPT, rules: GITHUB_THREADS_RULES },
};
