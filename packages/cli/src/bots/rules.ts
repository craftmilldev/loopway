import { randomUUID } from "node:crypto";
import { Environment } from "@marcbachmann/cel-js";
import type { BotRule, Message } from "../client.js";
import { createSources, NO_DEPS } from "@loopway/sources";

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
 * - Helpers a source defines for rules on its own event types, named `<source>_<helper>` (see `rules` on SourceAdapter in @loopway/sources).
 */
const base = new Environment({ unlistedVariablesAreDyn: true });

/** Each source's environment, for the rules whose type globs all start with its prefix. */
const sourceEnvs = createSources(NO_DEPS)
  .rules()
  .map(([prefix, extend]) => ({ prefix, env: extend(base.clone()) }));

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
  if (!Array.isArray(rules) || !rules.every((r) => Array.isArray(r?.types)))
    throw new Error("Rules must be a list of rules, each with a list of types.");
  for (const rule of rules)
    for (const field of ["subject", "related", "action"] as const)
      if (rule[field] !== undefined) envFor(rule).parse(rule[field]);
}

/**
 * Decides which thread a message goes to, given who holds each subject (`owner/repo#number` → thread id) and the
 * bot's rules. The rules whose type globs match the message are tried in order. Each finds a `subject` (the
 * message's own, "" for none) and `related` ones, and its `action` says what to do with them:
 *
 * - `skip`: move on to the next rule.
 * - `attach`: attach the message to the thread holding the subject (the own one first, then the related ones in
 *   order), or to a new thread if none does, and stop. This is the default.
 *
 * A message that no rule attached is dropped. `add_subjects` is every subject the rule found that no thread holds
 * yet. Ones another thread holds stay there.
 *
 * Doesn't change `held`; the caller adds `add_subjects` to it as it assigns, so later messages see them.
 */
export function route(rules: readonly BotRule[], held: ReadonlyMap<string, string>, e: Message): Routed | undefined {
  const vars = { event_type: e.event.type, data: e.event.data ?? {} };
  for (const rule of rules) {
    if (!rule.types.some((t) => matches(t, e.event.type))) continue;
    const env = envFor(rule);
    const key = (rule.subject !== undefined && (env.evaluate(rule.subject, vars) as string)) || undefined;
    const related = rule.related !== undefined ? (env.evaluate(rule.related, vars) as string[]) : [];
    const subjects = key ? [key, ...related] : [];
    const found = subjects.map((s) => held.get(s)).find(Boolean);
    const action =
      rule.action === undefined
        ? "attach"
        : (env.evaluate(rule.action, { ...vars, subject: key ?? "", related, held: !!found }) as string);
    if (action === "skip") continue;
    if (action !== "attach") throw new Error(`Unknown rule action "${action}"; use "attach" or "skip".`);
    return {
      thread_id: found ?? randomUUID(),
      add_subjects: [...new Set(subjects)].filter((s) => !held.has(s)),
      key,
    };
  }
  return undefined;
}
