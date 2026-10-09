import { randomUUID } from "node:crypto";
import type { Event } from "../client.js";
import { editSession, findSession, type Sessions } from "./store.js";

interface GithubPayload {
  number?: number;
  issue?: { number?: number };
  pull_request?: { number?: number; body?: string | null };
  repository?: { full_name?: string };
  check_run?: { pull_requests?: { number?: number }[] };
  check_suite?: { pull_requests?: { number?: number }[] };
  workflow_run?: { pull_requests?: { number?: number }[] };
}

/**
 * Which thread an event belongs to: `key` is its issue or PR (`owner/repo#number`), and `refs` are
 * the issues a PR body closes ("Closes #12"). Events with no issue or PR (e.g. push) have no key.
 */
export function threadKeys(e: Event): { key?: string; refs: string[] } {
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

/**
 * Decides which of the bot's sessions a message goes to:
 *
 * 1. Its issue/PR already belongs to a session → that session.
 * 2. It's a PR that closes a known issue ("Closes #N") → that issue's session, and the PR joins it.
 * 3. Otherwise → a new session.
 *
 * New sessions and links are added to `sessions` in place, for the caller to save.
 */
export function route(sessions: Sessions, botId: string, e: Event): { session: string; key?: string } {
  const { key, refs } = threadKeys(e);
  let id = key ? findSession(sessions, botId, key) : undefined;
  if (!id && key) {
    id = refs.map((r) => findSession(sessions, botId, r)).find(Boolean);
    if (id) editSession(sessions, id).keys.push(key);
  }
  return { session: id ?? newSession(sessions, botId, key), key };
}

function newSession(sessions: Sessions, botId: string, key: string | undefined): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  sessions[id] = {
    bot_id: botId,
    keys: key ? [key] : [],
    events: [],
    waiting: [],
    status: "active",
    started: false,
    created_at: now,
    updated_at: now,
  };
  return id;
}
