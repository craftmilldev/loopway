import { randomUUID } from "node:crypto";
import { Environment } from "@marcbachmann/cel-js";
import type { BotRule, Message } from "../client.js";

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
 * - In `skip` only: `subject` and `related` (what the rule's other expressions produced) and `held` (whether a
 *   thread already holds one of those subjects).
 * - Helpers a source defines for rules on its own event types, named `<source>_<helper>` (see SOURCES).
 */
const base = new Environment({ unlistedVariablesAreDyn: true });

/** A source's helpers, available to the rules whose type globs all start with its `prefix`. */
const SOURCES = [
  {
    prefix: "com.github.",
    env: base
      .clone()
      // The issue numbers a PR body closes ("Closes #12", "fixes #3"), as a list of strings.
      .registerFunction("github_closes(dyn): list<string>", (body: unknown) =>
        typeof body === "string"
          ? [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((m) => m[1]!)
          : [],
      ),
  },
];

/** The environment a rule runs in: its source's, if all its types are that source's, else the base one. */
function envFor(rule: BotRule): Environment {
  return SOURCES.find((s) => rule.types.every((t) => t.startsWith(s.prefix)))?.env ?? base;
}

/** Whether an event type matches a rule's glob, where `*` is any run of characters. */
function matches(glob: string, type: string): boolean {
  const re = glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${re.join(".*")}$`).test(type);
}

/** Throws if a rule's expressions don't parse, so a bad version fails when the bot starts, not on its first message. */
export function checkRules(rules: BotRule[]): void {
  for (const rule of rules)
    for (const field of ["subject", "related", "skip"] as const)
      if (rule[field] !== undefined) envFor(rule).parse(rule[field]);
}

/**
 * Decides which of the bot's threads a message goes to, given who holds each subject (`owner/repo#number` →
 * thread id) and the bot's rules. The first rule with a type glob matching the message applies; a message no rule
 * matches is dropped. The rule's `subject` is the message's own subject ("" for none), its `related` the other
 * subjects it names, and its `skip` drops the message.
 *
 * 1. The thread holding the message's own subject wins.
 * 2. Otherwise the first related subject, in order, that a thread holds wins.
 * 3. Otherwise it's a new thread.
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
  if (
    rule.skip !== undefined &&
    env.evaluate(rule.skip, { ...vars, subject: key ?? "", related, held: !!found }) === true
  )
    return undefined;
  return {
    thread_id: found ?? randomUUID(),
    add_subjects: [...new Set(subjects)].filter((s) => !held.has(s)),
    key,
  };
}

/** The rules of the `github-threads` bot kind. */
export const GITHUB_THREADS_RULES: BotRule[] = [
  // CI runs belong to the PR they ran for; a run with no PR (on main) belongs to no thread.
  ...(["check_run", "check_suite", "workflow_run"] as const).map((kind) => ({
    types: [`com.github.${kind}.*`],
    subject: `has(data.repository) && has(data.${kind}) && has(data.${kind}.pull_requests) && size(data.${kind}.pull_requests) > 0 ? data.repository.full_name + '#' + string(data.${kind}.pull_requests[0].number) : ''`,
    skip: "subject == ''",
  })),
  // Everything else belongs to its issue or PR, and to the issues a PR body closes. An issue labeled `future` is
  // recorded but not worked on until a message arrives after the label is removed.
  {
    types: ["com.github.*"],
    subject:
      "has(data.repository) && (has(data.pull_request) || has(data.issue) || has(data.number)) ? data.repository.full_name + '#' + string(has(data.pull_request) ? data.pull_request.number : has(data.issue) ? data.issue.number : data.number) : ''",
    related:
      "has(data.repository) && has(data.pull_request) && has(data.pull_request.body) ? github_closes(data.pull_request.body).map(n, data.repository.full_name + '#' + n) : []",
    skip: "!held && has(data.issue) && has(data.issue.labels) && data.issue.labels.exists(l, l.name == 'future')",
  },
];
