import type { BotRule } from "@loopway/rules";
import { THREAD_PROMPT } from "./github-threads-prompt.js";
import { GITHUB_THREADS_RULES } from "./github-threads-rules.js";

/** A template for a new bot's first version. The bot doesn't remember which one it came from. */
export interface Preset {
  /** What the dashboard calls it. */
  label: string;
  /** What the dashboard says about it when it's picked. */
  description: string;
  prompt: string;
  rules: BotRule[];
}

const BLANK_PROMPT = `You are a loopway thread session, working on the messages of a thread.

\`loopway bots run\` reads the messages for you. It started this session with the first message of a
thread and resumes it whenever new messages for that thread arrive. Do the work, then end your turn;
you'll be resumed with the next messages. Read each message with the command it comes with.

Edit this prompt to say what this bot is for and how it should work.`;

export const PRESETS: Record<string, Preset> = {
  "github-threads": {
    label: "GitHub threads",
    description:
      "One session per GitHub issue or pull request: it triages the issue, does the work, opens a PR, and follows its reviews and CI.",
    prompt: THREAD_PROMPT,
    rules: GITHUB_THREADS_RULES,
  },
  blank: {
    label: "Start blank",
    description: "A short generic prompt and one catch-all rule. For when you know what you want.",
    prompt: BLANK_PROMPT,
    rules: [{ types: ["*"] }],
  },
};
