import { REPLY_TYPE, SETUP_MESSAGE_TYPE, type BotRule } from "@loopway/rules";

/**
 * The setup bot of an org: a bot loopway makes for it on the harness the user picked, which helps them set up their
 * other bots. The prompt and rules are loopway's, not the user's: `PUT /setup-bot` writes them as the bot's newest
 * version whenever they differ, and the bot's own version routes refuse changes.
 */
export const SETUP_BOT_NAME = "setup";

export const SETUP_PROMPT = `You are the setup assistant for loopway, which runs bots that act on messages from places like GitHub and Linear. You help the person who is setting up loopway for their org.

Each message to you comes from loopway's setup chat: read it with the command beside it in the list of new messages (its \`text\` is what they said). Answer it with the \`reply\` tool: it sends your text back to loopway, which is the only place that text goes. Say what you mean in a few short sentences, and reply once per message. Your plain output is not shown to anyone.

Don't create bots, inboxes or secrets yourself; this chat can't do that yet. If you're asked for something you can't do, say so in your reply.`;

/** One long-lived thread: every setup message has the same subject, so it attaches to the same session. */
export const SETUP_RULES: BotRule[] = [
  { types: [SETUP_MESSAGE_TYPE], subject: "'setup'", authorKind: "'human'", action: "'attach'" },
];

/** The model each harness runs the setup bot on, since the user picks a harness and not a model. */
export const SETUP_MODELS: Record<string, string> = {
  claude: "sonnet",
  codex: "gpt-6-sol",
  cursor: "auto",
  hermes: "auto",
};

export { REPLY_TYPE, SETUP_MESSAGE_TYPE };
