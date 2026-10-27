import type { BotRule } from "@loopway/rules";
import { THREAD_PROMPT } from "./github-threads-prompt.js";
import { GITHUB_THREADS_RULES } from "./github-threads-rules.js";
import { MERGED_PR_TICKET_PROMPT } from "./merged-pr-ticket-prompt.js";
import { MERGED_PR_TICKET_RULES } from "./merged-pr-ticket-rules.js";

export {
  MANAGER_ALLOWED_TOOLS,
  MANAGER_CHANGE_COMMANDS,
  MANAGER_DENIED_TOOLS,
  MANAGER_PROMPT,
} from "./manager-prompt.js";

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
  "merged-pr-ticket": {
    label: "Merged PR → ticket",
    description:
      "When a pull request merges, links it to its ticket (Linear key or link in the title, branch or body), or asks the author for one and labels it needs-ticket. For audits like SOC 2 that need every change tied to a ticket.",
    prompt: MERGED_PR_TICKET_PROMPT,
    rules: MERGED_PR_TICKET_RULES,
  },
};
