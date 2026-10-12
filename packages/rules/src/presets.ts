import type { BotRule } from "./index.js";
import { GITHUB_THREADS_RULES } from "./presets/github-threads-rules.js";
import { THREAD_PROMPT } from "./presets/github-threads-prompt.js";

/**
 * A kind of bot to start from. A new bot of a preset's `id` starts with its prompt and rules as its first version,
 * which can then be edited.
 */
export interface Preset {
  /** The `kind` a bot made from it has. */
  id: string;
  label: string;
  description: string;
  /** The instructions a session starts with. */
  prompt: string;
  /** The assign rules (see `route`). */
  rules: BotRule[];
}

export const PRESETS: readonly Preset[] = [
  {
    id: "github-threads",
    label: "GitHub threads",
    description:
      "One Claude Code session per GitHub issue or pull request: it triages issues, asks questions, does the work in a worktree, opens the PR and follows its reviews and CI.",
    prompt: THREAD_PROMPT,
    rules: GITHUB_THREADS_RULES,
  },
];

/** The preset with this id, if there is one. */
export const preset = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);
