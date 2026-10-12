import { randomUUID } from "node:crypto";
import { Environment } from "@marcbachmann/cel-js";
import type { BotRule, Message } from "../client.js";
import { RULE_SOURCES } from "./sources/index.js";

/** Where `route` sends a message: a thread, the subjects to add to it, and the message's own subject for display. */
export interface Routed {
  /** An existing thread's id, or a new one's (made here; `assign` creates it). */
  thread_id: string;
  add_subjects: string[];
  key?: string;
}

/**
 * The CEL environment rules run in. It is plain CEL plus this small API:
 *
 * - `data`: the event's payload, and `event_type`: its type.
 * - In `action` only: `subject` and `related` (what the rule's other expressions produced) and `held` (whether a
 *   thread already holds one of those subjects).
 * - Helpers a source defines for rules on its own event types, named `<source>_<helper>` (see RuleSource).
 */
const base = new Environment({ unlistedVariablesAreDyn: true });

/**
 * A source's contribution to rules: the helpers its event types' rules can call. Each source defines its own in
 * sources/<source>.ts and is listed in RULE_SOURCES.
 */
export interface RuleSource {
  /** The event type prefix of the source, e.g. "com.github.". */
  prefix: string;
  /** Adds the source's helpers, named `<source>_<helper>`, to an environment. */
  extend(env: Environment): Environment;
}

/** Each source's environment, for the rules whose type globs all start with its prefix. */
const sourceEnvs = RULE_SOURCES.map((s) => ({ prefix: s.prefix, env: s.extend(base.clone()) }));

/** The environment a rule runs in: its source's, if all its types are that source's, else the base one. */
function envFor(rule: BotRule): Environment {
  return sourceEnvs.find((s) => rule.types.every((t) => t.startsWith(s.prefix)))?.env ?? base;
}

/** Whether an event type matches a rule's glob, where `*` is any run of characters. */
function matches(glob: string, type: string): boolean {
  const re = glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${re.join(".*")}$`).test(type);
}

/** Throws if a rule's expressions don't parse, so a bad version fails when the bot starts, not on its first message. */
export function checkRules(rules: BotRule[]): void {
  for (const rule of rules)
    for (const field of ["subject", "related", "action"] as const)
      if (rule[field] !== undefined) envFor(rule).parse(rule[field]);
}

/**
 * Decides which of the bot's threads a message goes to, given who holds each subject (`owner/repo#number` →
 * thread id) and the bot's rules. The first rule with a type glob matching the message applies; a message no rule
 * matches is dropped. The rule's `subject` is the message's own subject ("" for none), its `related` the other
 * subjects it names. Its `action` says what to do with what that finds: `attach-once` (the default) or `skip`.
 *
 * `attach-once`:
 * 1. The thread holding the message's own subject wins.
 * 2. Otherwise the first related subject, in order, that a thread holds wins.
 * 3. Otherwise it's a new thread.
 *
 * `skip` drops the message.
 *
 * `add_subjects` is every collected subject no thread holds yet. Ones another thread holds stay there.
 *
 * Doesn't change `held`; the caller adds `add_subjects` to it as it assigns, so later messages see them.
 */
export function route(rules: readonly BotRule[], held: ReadonlyMap<string, string>, e: Message): Routed | undefined {
  const rule = rules.find((r) => r.types.some((t) => matches(t, e.event.type)));
  if (!rule) return undefined;
  const env = envFor(rule);
  const vars = { event_type: e.event.type, data: e.event.data ?? {} };
  const key = (rule.subject !== undefined && (env.evaluate(rule.subject, vars) as string)) || undefined;
  const related = rule.related !== undefined ? (env.evaluate(rule.related, vars) as string[]) : [];
  const subjects = key ? [key, ...related] : [];
  const found = subjects.map((s) => held.get(s)).find(Boolean);
  const action =
    rule.action === undefined
      ? "attach-once"
      : (env.evaluate(rule.action, { ...vars, subject: key ?? "", related, held: !!found }) as string);
  if (action === "skip") return undefined;
  if (action !== "attach-once") throw new Error(`Unknown rule action "${action}"; use "attach-once" or "skip".`);
  return {
    thread_id: found ?? randomUUID(),
    add_subjects: [...new Set(subjects)].filter((s) => !held.has(s)),
    key,
  };
}
