import type { BotRule } from "@loopway/rules";
import { THREAD_PROMPT } from "./github-threads-prompt.js";
import { GITHUB_THREADS_RULES } from "./github-threads-rules.js";

export { MANAGER_ALLOWED_TOOLS, MANAGER_DENIED_TOOLS, MANAGER_PROMPT } from "./manager-prompt.js";

/** A template for a new bot's first version. The bot doesn't remember which one it came from. */
export interface Preset {
  /** What the dashboard calls it. */
  label: string;
  /** What the dashboard says about it when it's picked. */
  description: string;
  prompt: string;
  rules: BotRule[];
}

export const PRESETS: Record<string, Preset> = {
  "github-threads": {
    label: "GitHub threads",
    description:
      "One session per GitHub issue or pull request: it triages the issue, does the work, opens a PR, and follows its reviews and CI.",
    prompt: THREAD_PROMPT,
    rules: GITHUB_THREADS_RULES,
  },
};
