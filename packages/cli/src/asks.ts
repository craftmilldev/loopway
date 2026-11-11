import type { Bot } from "./bots.js";
import type { ThreadEvent } from "./format.js";
import { RateLimitError, type Reaction, type SubjectSource } from "./source.js";
import type { Thread } from "./thread.js";
import type { Threads } from "./threads.js";

/** What loopway's `permission` tool tells Claude Code: let the call through, or refuse it with a reason. */
export type PermissionResult = { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string };

export const allow = (input: unknown): PermissionResult => ({ behavior: "allow", updatedInput: input });
export const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

/** A question or permission request a thread has put to people, and is waiting on. */
export interface Ask {
  id: string;
  kind: "permission" | "question";
  /** Where it was asked: the comment on `subject`. */
  commentUrl: string;
  subject: string;
  /** The tool the session wanted to use, or `ask` for a question. */
  tool: string;
  /** The tool's input, or the question's text. */
  input: unknown;
  /** ISO time. */
  at: string;
  /** ISO time. Set once someone has answered. */
  answeredAt?: string;
}

export const openAsks = (thread: Thread): Ask[] => (thread.asks ?? []).filter((a) => !a.answeredAt);

/** The same call: the same tool with the same input. */
export const callKey = (tool: string, input: unknown) => `${tool} ${JSON.stringify(input)}`;

/** Whether `thread`'s session was already allowed to make this call. */
export const wasApproved = (thread: Thread, tool: string, input: unknown) =>
  !!thread.session?.approved?.includes(callKey(tool, input));

const SHOWN = 500;

/** What a call does: a Bash command as it is, anything else as JSON. Trimmed. */
export function describeInput(input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  const text = typeof input === "string" ? input : typeof command === "string" ? command : JSON.stringify(input);
  return text.length > SHOWN ? text.slice(0, SHOWN) + "…" : text;
}

/** An ask in a few words, for the log and the TUI. */
export const askLabel = (ask: Ask) =>
  (ask.kind === "question" ? describeInput(ask.input) : `${ask.tool} ${describeInput(ask.input)}`).replace(/\s+/g, " ");

/** The comment that asks for a 👍 or a 👎. */
export const permissionComment = (tool: string, input: unknown) =>
  [
    `loopway-bot wants to use \`${tool}\`:`,
    "```",
    describeInput(input),
    "```",
    "React 👍 to allow it, or 👎 to deny it. Only the owner's reaction counts.",
  ].join("\n");

/** The comment that carries a question. */
export const questionComment = (question: string) => `${question}\n\nReply here to answer: loopway-bot is waiting.`;

/** What the session reads when its call was refused for now. */
export const waitingMessage = (ask: Ask) =>
  `loopway asked about this call (${ask.commentUrl}) and is waiting for an answer. Do not retry it or work around it: ` +
  "end your turn. You will be resumed once it is answered.";

/** What the session reads once it has asked a question. */
export const askedMessage = (url: string) => `asked: ${url}. End your turn now: you will be resumed with the answer.`;

/** The rules of a bot's front matter: `deny` wins over `allow`, and no match leaves it undecided. */
export function ruleDecision(
  bot: Pick<Bot, "allow" | "deny">,
  tool: string,
  input: unknown,
): "allow" | "deny" | undefined {
  if (bot.deny.some((pattern) => matches(pattern, tool, input))) return "deny";
  if (bot.allow.some((pattern) => matches(pattern, tool, input))) return "allow";
}

/**
 * Claude Code's permission syntax: `Bash` is every call of the tool, `Bash(npm test:*)` the commands that start with
 * `npm test`, `Bash(git status)` that command exactly, and `Read(src/*)` a glob over the path the tool works on.
 */
export function matches(pattern: string, tool: string, input: unknown): boolean {
  const parsed = /^([^(]+)\((.*)\)$/.exec(pattern);
  if (!parsed) return pattern === tool;
  const name = parsed[1]!;
  const spec = parsed[2]!;
  const target = targetOf(input);
  if (name !== tool || target === undefined) return false;
  if (spec.endsWith(":*")) return target === spec.slice(0, -2) || target.startsWith(spec.slice(0, -2) + " ");
  return new RegExp("^" + spec.split("*").map(escape).join(".*") + "$").test(target);
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

export interface ReactionReader {
  threads: Threads;
  source: Pick<SubjectSource, "reactions">;
  /** Your `gh` login: nobody else's reaction counts. */
  owner: string;
  emit: (event: ThreadEvent) => void;
  log?: (message: string) => void;
}

/**
 * Reads the reactions on every open permission ask of an open thread, and answers the ones the owner has reacted to.
 * A 👎 wins over a 👍. A failed read is logged and tried again on the next pass, except a rate limit, which stops it.
 */
export async function answerFromReactions(o: ReactionReader): Promise<void> {
  for (const thread of o.threads.all.filter((t) => t.status === "open")) {
    for (const ask of openAsks(thread).filter((a) => a.kind === "permission")) {
      try {
        const verdict = ownerVerdict(await o.source.reactions(ask.commentUrl), o.owner);
        if (verdict) o.emit(await o.threads.answerPermission(thread, ask, verdict === "approved", o.owner));
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        o.log?.(`reactions on ${ask.commentUrl}: ${(err as Error).message}`);
      }
    }
  }
}

function ownerVerdict(reactions: Reaction[], owner: string): "approved" | "denied" | undefined {
  const mine = reactions.filter((r) => r.user.toLowerCase() === owner.toLowerCase()).map((r) => r.content);
  if (mine.includes("-1")) return "denied";
  if (mine.includes("+1")) return "approved";
}

/** The command, path or address a call works on. */
function targetOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const fields = input as Record<string, unknown>;
  return [fields.command, fields.file_path, fields.path, fields.url].find((v): v is string => typeof v === "string");
}
