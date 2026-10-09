import type { Message } from "../client.js";
import { threadPrompt } from "./agent.js";
import { route as routeGithub } from "./routing.js";
import type { Sessions } from "./store.js";

/** How `loopway bots run` runs a bot of some `kind`. The server stores any kind; the CLI runs these. */
export interface BotKind {
  /**
   * Which session a message belongs to, adding a new session or a link to `sessions` (inside
   * withSessions()) as needed. No `session` means the message is dropped. `key` names the message's thread for the session and the TUI.
   */
  route(sessions: Sessions, botId: string, message: Message): { session?: string; key?: string };
  /** The instructions a new session starts with. */
  prompt(): Promise<string>;
}

export const BOT_KINDS: Record<string, BotKind> = {
  "github-threads": { route: routeGithub, prompt: threadPrompt },
};
