import { randomUUID } from "node:crypto";
import { Environment } from "@marcbachmann/cel-js";

/**
 * One assign rule of a bot. The first rule with a type glob matching a message applies; each field is a CEL
 * expression over the message (see `route`): `subject` gives the message's own subject ("" for none), `related`
 * the subjects it also names, `authorKind` whether a person or a bot made the message (`'human'`, `'bot'` or `''` for
 * unknown), and `action` (required) what to do with what they find (`attach` or `skip`).
 */
export interface BotRule {
  types: string[];
  subject?: string;
  related?: string;
  authorKind?: string;
  action: string;
}

/**
 * The type of a message a person sends to a thread directly (see `POST /bots/:botId/threads/:threadId/messages`).
 * Its subject and `data.thread_id` are the thread's id; `route` sends it there without asking the bot's rules.
 */
export const THREAD_MESSAGE_TYPE = "dev.loopway.thread.message";

/** What `route` reads of a message: its CloudEvent's type and payload. */
export interface RoutableMessage {
  event: { type: string; data?: unknown };
}

/** Where `route` sends a message: a thread, the subjects to add to it, and the message's own subject for display. */
export interface Routed {
  /** An existing thread's id, or a new one's (made here; `assign` creates it). */
  thread_id: string;
  add_subjects: string[];
  key?: string;
  /** Who made the message, if the rule said: it sets the thread's level of automation. */
  author_kind?: "human" | "bot";
}

/**
 * The CEL environment rules run in. It is plain CEL plus this small API:
 *
 * - `data`: the event's payload, and `event_type`: its type.
 * - In `authorKind`: nothing more; it returns `'human'`, `'bot'` or `''` when the rule can't tell.
 * - In `action` only: `subject` and `related` (what the rule's other expressions produced) and `held` (whether a
 *   thread already holds one of those subjects).
 * - `regex_all(text, pattern)` and `regex_all(text, pattern, flags)`: the first capture group (or the whole match if
 *   the pattern has none) of every match of a JavaScript regular expression in the text, as a list of strings.
 *   `flags` are JavaScript regex flags such as "i" or "m". The rule decides what counts as a match.
 */
const base = new Environment({ unlistedVariablesAreDyn: true })
  .registerFunction("regex_all(string, string): list<string>", (text: string, pattern: string) =>
    regexAll(text, pattern, ""),
  )
  .registerFunction("regex_all(string, string, string): list<string>", (text: string, pattern: string, flags: string) =>
    regexAll(text, pattern, flags),
  );

function regexAll(text: string, pattern: string, flags: string): string[] {
  return [...text.matchAll(new RegExp(pattern, flags.includes("g") ? flags : flags + "g"))].map((m) => m[1] ?? m[0]);
}

/** Whether an event type matches a rule's glob, where `*` is any run of characters. */
function matches(glob: string, type: string): boolean {
  const re = glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${re.join(".*")}$`).test(type);
}

/** Throws if a rule's expressions don't parse, so a bad version fails when the bot starts, not on its first message. */
export function checkRules(rules: BotRule[]): void {
  if (!Array.isArray(rules) || !rules.every((r) => Array.isArray(r?.types)))
    throw new Error("Rules must be a list of rules, each with a list of types.");
  rules.forEach((rule, i) => {
    if (typeof rule.action !== "string" || !rule.action)
      throw new Error(`Rule ${i + 1} has no action; every rule needs one, such as "'attach'" or "'skip'".`);
    for (const field of ["subject", "related", "authorKind", "action"] as const)
      if (rule[field] !== undefined) base.parse(rule[field]);
  });
}

/**
 * Decides which thread a message goes to, given who holds each subject (`owner/repo#number` → thread id) and the
 * bot's rules. The rules whose type globs match the message are tried in order. Each finds a `subject` (the
 * message's own, "" for none) and `related` ones, and its `action` says what to do with them:
 *
 * - `skip`: move on to the next rule.
 * - `attach`: attach the message to the thread holding the subject (the own one first, then the related ones in
 *   order), or to a new thread if none does, and stop.
 *
 * A message that no rule attached is dropped. A message sent to a thread (THREAD_MESSAGE_TYPE) skips the rules.
 * `add_subjects` is every subject the rule found that no thread holds
 * yet. Ones another thread holds stay there.
 *
 * Doesn't change `held`; the caller adds `add_subjects` to it as it assigns, so later messages see them.
 */
export function route(
  rules: readonly BotRule[],
  held: ReadonlyMap<string, string>,
  e: RoutableMessage,
): Routed | undefined {
  if (e.event.type === THREAD_MESSAGE_TYPE) {
    const id = (e.event.data as { thread_id?: unknown } | undefined)?.thread_id;
    return typeof id === "string" ? { thread_id: id, add_subjects: [], author_kind: "human" } : undefined;
  }
  const vars = { event_type: e.event.type, data: e.event.data ?? {} };
  for (const rule of rules) {
    if (!rule.types.some((t) => matches(t, e.event.type))) continue;
    const key = (rule.subject !== undefined && (base.evaluate(rule.subject, vars) as string)) || undefined;
    const related = rule.related !== undefined ? (base.evaluate(rule.related, vars) as string[]) : [];
    const subjects = key ? [key, ...related] : [];
    const found = subjects.map((s) => held.get(s)).find(Boolean);
    const action = base.evaluate(rule.action, { ...vars, subject: key ?? "", related, held: !!found }) as string;
    if (action === "skip") continue;
    if (action !== "attach") throw new Error(`Unknown rule action "${action}"; use "attach" or "skip".`);
    const kind: unknown = rule.authorKind !== undefined ? base.evaluate(rule.authorKind, vars) : "";
    if (kind !== "" && kind !== "human" && kind !== "bot")
      throw new Error(`Unknown author kind "${String(kind)}"; use "human", "bot" or "".`);
    return {
      thread_id: found ?? randomUUID(),
      add_subjects: [...new Set(subjects)].filter((s) => !held.has(s)),
      key,
      ...(kind ? { author_kind: kind } : {}),
    };
  }
  return undefined;
}
