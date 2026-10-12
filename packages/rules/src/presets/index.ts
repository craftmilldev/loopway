import type { BotRule } from "../index.js";
import { THREAD_PROMPT } from "./github-threads/prompt.js";
import { GITHUB_THREADS_RULES } from "./github-threads/rules.js";

/** A starting point for a bot: the prompt and rules a new bot of this kind begins with, and how to describe it. */
export interface Preset {
  label: string;
  description: string;
  /** The instructions a new session starts with. */
  prompt: string;
  /** The assign rules a new bot of this kind starts with (see route). */
  rules: BotRule[];
}

/** The presets, keyed by the bot kind they create. The server stores any kind; these are the ones it can start from. */
export const PRESETS: Record<string, Preset> = {
  "github-threads": {
    label: "GitHub threads",
    description:
      "One session per GitHub issue or pull request: it triages the issue, does the work, opens a PR, and follows its reviews and CI.",
    prompt: THREAD_PROMPT,
    rules: GITHUB_THREADS_RULES,
  },
};
