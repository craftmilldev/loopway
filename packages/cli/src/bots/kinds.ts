import type { Message } from "../client.js";
import { threadPrompt } from "./agent.js";
import { route as routeGithub, type Routed } from "./routing.js";

/** How `loopway bots run` runs a bot of some `kind`. The server stores any kind; the CLI runs these. */
export interface BotKind {
  /**
   * Which thread a message belongs to, given the thread holding each subject of the bot (see `route` in
   * routing.ts). Undefined means the message is dropped. `key` names the message's thread for the thread and the TUI.
   */
  route(held: ReadonlyMap<string, string>, message: Message): Routed | undefined;
  /** The instructions a new session starts with. */
  prompt(): Promise<string>;
}

export const BOT_KINDS: Record<string, BotKind> = {
  "github-threads": { route: routeGithub, prompt: threadPrompt },
};
