import { randomUUID } from "node:crypto";
import { Environment } from "@marcbachmann/cel-js";
import type { Message } from "../client.js";

/**
 * How a bot turns a message into subjects: the first rule whose `types` match the message's type applies. The
 * expressions are CEL, evaluated with the message's CloudEvent as `event` (so `event.data.issue.number`). An
 * expression that fails (a missing field, say) counts as having no value: no subject, no related subjects, no skip.
 */
export interface Rule {
  /** CloudEvent types the rule applies to; `*` matches anything, so `com.github.check_run.*` matches every check run. */
  types: string[];
  /** The message's own subject, a string; the message has none if it's missing. */
  subject?: string;
  /** Subjects related to the message, a list of strings, e.g. the issues a PR closes. */
  related?: string;
  /** A bool: drop the message unless some thread already holds one of its subjects. */
  skip?: string;
}

/** Decides a message's thread: see `compileRules`. */
export type Router = (held: ReadonlyMap<string, string>, e: Message) => Routed | undefined;

/** Where `route` sends a message: a thread, the subjects to add to it, and the message's own subject for display. */
export interface Routed {
  /** An existing thread's id, or a new one's (made here; `assign` creates it). */
  thread_id: string;
  add_subjects: string[];
  key?: string;
}

const env = new Environment({ unlistedVariablesAreDyn: true, enableOptionalTypes: true }).registerFunction(
  "closes(string, string): list",
  (text: string, repo: string) =>
    [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((m) => `${repo}#${m[1]}`),
);

/** The rules of the `github-threads` bot: its subject is its issue or PR, `owner/repo#number`. */
export const GITHUB_RULES: Rule[] = [
  {
    // CI runs belong to the PR they ran for. Ones with no PR (a run on main) belong to no thread.
    types: ["com.github.check_run.*", "com.github.check_suite.*", "com.github.workflow_run.*"],
    subject:
      'event.data.repository.full_name + "#" + string(event.data.?check_run.or(event.data.?check_suite).or(event.data.?workflow_run).value().pull_requests[0].number)',
    skip: "true",
  },
  {
    // Everything else with an issue or PR belongs to it, and a PR also to the issues its body closes. A message for an
    // issue labeled `future` with no thread is recorded, not to be worked on; removing the label lets the next one start.
    types: ["com.github.*"],
    subject:
      'event.data.repository.full_name + "#" + string(event.data.?pull_request.?number.or(event.data.?issue.?number).or(event.data.?number).value())',
    related: 'closes(event.data.?pull_request.?body.orValue(""), event.data.repository.full_name)',
    skip: 'event.data.?issue.?labels.orValue([]).exists(l, l.name == "future")',
  },
];

/** Checks the rules' expressions parse; throws naming the rule and field that doesn't. */
export function checkRules(rules: Rule[]): void {
  rules.forEach((rule, i) => {
    for (const field of ["subject", "related", "skip"] as const) {
      const expression = rule[field];
      if (expression === undefined) continue;
      try {
        env.parse(expression);
      } catch (err) {
        throw new Error(`Rule ${i + 1}'s ${field} doesn't parse: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
    }
  });
}

const pattern = (glob: string) => new RegExp(`^${glob.split("*").map(escape).join(".*")}$`);
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

function evaluate(expression: string | undefined, event: Message["event"]): unknown {
  if (expression === undefined) return undefined;
  try {
    return env.evaluate(expression, { event });
  } catch {
    return undefined;
  }
}

/**
 * Decides which of the bot's threads a message goes to, given who holds each subject (subject → thread id). It
 * collects the message's subjects with the first rule that matches its type: its own, then the related ones.
 *
 * 1. The thread holding the message's own subject wins.
 * 2. Otherwise the first related subject, in order, that a thread holds wins.
 * 3. Otherwise it's a new thread.
 *
 * `add_subjects` is every collected subject no thread holds yet. Ones another thread holds stay there. A message whose
 * rule says to skip it, and no thread holds a subject of, gets no route (undefined). A message no rule matches goes to a
 * new thread with no subjects.
 *
 * Doesn't change `held`; the caller adds `add_subjects` to it as it assigns, so later messages see them.
 */
export function compileRules(rules: Rule[]): Router {
  checkRules(rules);
  const matchers = rules.map((rule) => ({ rule, types: rule.types.map(pattern) }));
  return function route(held: ReadonlyMap<string, string>, e: Message): Routed | undefined {
    const rule = matchers.find((m) => m.types.some((t) => t.test(e.event.type)))?.rule;
    const own = evaluate(rule?.subject, e.event);
    const related = evaluate(rule?.related, e.event);
    const key = typeof own === "string" && own ? own : undefined;
    const subjects = [
      ...(key ? [key] : []),
      ...(Array.isArray(related) ? related.filter((s): s is string => typeof s === "string" && !!s) : []),
    ];
    const found = subjects.map((s) => held.get(s)).find(Boolean);
    if (!found && evaluate(rule?.skip, e.event) === true) return undefined;
    return {
      thread_id: found ?? randomUUID(),
      add_subjects: [...new Set(subjects)].filter((s) => !held.has(s)),
      key,
    };
  };
}
