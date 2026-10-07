import { randomUUID } from "node:crypto";
import type { Event } from "../client.js";
import { editSession, findSession, type Sessions } from "./store.js";

interface GithubPayload {
  number?: number;
  issue?: { number?: number };
  pull_request?: { number?: number; body?: string | null };
  repository?: { full_name?: string };
}

/**
 * Which thread an event belongs to: `key` is its issue or PR (`owner/repo#number`), and `refs` are
 * the issues a PR body closes ("Closes #12"). Events with no issue or PR (e.g. push) have no key.
 */
export function threadKeys(e: Event): { key?: string; refs: string[] } {
  const d = (e.event.data ?? {}) as GithubPayload;
  const repo = d.repository?.full_name;
  const n = d.pull_request?.number ?? d.issue?.number ?? d.number;
  if (!repo || typeof n !== "number") return { refs: [] };
  const body = d.pull_request?.body ?? "";
  const refs = [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((m) => `${repo}#${m[1]}`);
  return { key: `${repo}#${n}`, refs };
}

export interface RouteOptions {
  inboxId: string;
  max: number;
  /** Session ids with a run in flight. */
  running: ReadonlySet<string>;
}

export interface Routes {
  /** Session id → the pending events to hand it now. */
  deliveries: Map<string, Event[]>;
  /** Events left pending because --max runs are already in flight. */
  waiting: number;
}

/**
 * Decides where each pending event goes, oldest first:
 *
 * 1. Its issue/PR already belongs to a session → that session.
 * 2. It's a PR that closes a known issue ("Closes #N") → that issue's session, and the PR joins it.
 * 3. Otherwise → a new session.
 *
 * --max caps runs in flight, not sessions: a session waiting for its next event doesn't hold a
 * slot, so starting or resuming one takes a free slot, oldest event first. A running session's
 * events wait for its run to exit. New sessions and links are added to `sessions` in place, for the
 * caller to save.
 */
export function route(sessions: Sessions, pending: Event[], { inboxId, max, running }: RouteOptions): Routes {
  const deliveries = new Map<string, Event[]>();
  let waiting = 0;

  for (const e of pending) {
    const { key, refs } = threadKeys(e);
    let id = key ? findSession(sessions, inboxId, key) : undefined;
    if (!id && key) {
      id = refs.map((r) => findSession(sessions, inboxId, r)).find(Boolean);
      if (id) editSession(sessions, id).keys.push(key);
    }

    if (id && running.has(id)) continue;
    if (!id || !deliveries.has(id)) {
      if (running.size + deliveries.size >= max) {
        waiting++;
        continue;
      }
      id ??= newSession(sessions, inboxId, key);
    }
    deliveries.set(id, [...(deliveries.get(id) ?? []), e]);
  }
  return { deliveries, waiting };
}

function newSession(sessions: Sessions, inboxId: string, key: string | undefined): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  sessions[id] = { inbox_id: inboxId, keys: key ? [key] : [], events: [], status: "active", started: false, created_at: now, updated_at: now };
  return id;
}
