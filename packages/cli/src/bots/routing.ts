import { randomUUID } from "node:crypto";
import type { Message } from "../client.js";

interface GithubPayload {
  number?: number;
  issue?: { number?: number; labels?: { name?: string }[] };
  pull_request?: { number?: number; body?: string | null };
  repository?: { full_name?: string };
  check_run?: { pull_requests?: { number?: number }[] };
  check_suite?: { pull_requests?: { number?: number }[] };
  workflow_run?: { pull_requests?: { number?: number }[] };
}

/**
 * Which thread a message belongs to: `key` is its issue or PR (`owner/repo#number`), and `refs` are
 * the issues a PR body closes ("Closes #12"). Messages with no issue or PR (e.g. push) have no key.
 */
export function threadKeys(e: Message): { key?: string; refs: string[] } {
  const d = (e.event.data ?? {}) as GithubPayload;
  const repo = d.repository?.full_name;
  const ci = d.check_run ?? d.check_suite ?? d.workflow_run;
  const n = d.pull_request?.number ?? d.issue?.number ?? d.number ?? ci?.pull_requests?.[0]?.number;
  if (!repo || typeof n !== "number") return { refs: [] };
  const body = d.pull_request?.body ?? "";
  const refs = [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map(
    (m) => `${repo}#${m[1]}`,
  );
  return { key: `${repo}#${n}`, refs };
}

/** Where `route` sends a message: a thread, the subjects to add to it, and the message's own subject for display. */
export interface Routed {
  /** An existing thread's id, or a new one's (made here; `assign` creates it). */
  thread_id: string;
  add_subjects: string[];
  key?: string;
}

/**
 * Decides which of the bot's threads a message goes to, given who holds each subject (`owner/repo#number` →
 * thread id). It collects the message's subjects: its own issue or PR, then the issues a PR body closes.
 *
 * 1. The thread holding the message's own subject wins.
 * 2. Otherwise the first closed issue, in body order, that a thread holds wins.
 * 3. Otherwise it's a new thread.
 *
 * `add_subjects` is every collected subject no thread holds yet. Ones another thread holds stay there.
 *
 * CI messages with no PR (a run on main) belong to no thread and get no route. Neither do messages for an
 * issue labeled `future` that has no thread yet: it's recorded, not to be worked on. Removing the label
 * lets the next message for the issue start a thread.
 *
 * Doesn't change `held`; the caller adds `add_subjects` to it as it assigns, so later messages see them.
 */
export function route(held: ReadonlyMap<string, string>, e: Message): Routed | undefined {
  const { key, refs } = threadKeys(e);
  if (!key && /^com\.github\.(check_run|check_suite|workflow_run)\./.test(e.event.type)) return undefined;
  const subjects = key ? [key, ...refs] : [];
  const found = subjects.map((s) => held.get(s)).find(Boolean);
  if (!found && isFuture(e)) return undefined;
  return {
    thread_id: found ?? randomUUID(),
    add_subjects: [...new Set(subjects)].filter((s) => !held.has(s)),
    key,
  };
}

function isFuture(e: Message): boolean {
  const d = (e.event.data ?? {}) as GithubPayload;
  return !!d.issue?.labels?.some((l) => l.name === "future");
}
