import { join } from "node:path";
import { readJson, writeJson } from "./config.js";

/**
 * Agent sessions started by `loopway threads`, kept in ~/.loopway/threads.json keyed by session id.
 * A session owns a thread: the issues and PRs in `keys` (`owner/repo#number`). Both the dispatcher
 * and `loopway threads link` (run by the agent) write this file, so always load → change → save.
 */
export interface Session {
  inbox_id: string;
  keys: string[];
  /** `ended` once the run that handled a close event exits; ended sessions don't count toward --max. */
  status: "active" | "ended";
  /** Whether a claude session with this id exists yet (first run uses --session-id, later ones --resume). */
  started: boolean;
  created_at: string;
  updated_at: string;
}

export type Sessions = Record<string, Session>;

const threadsPath = (dir: string) => join(dir, "threads.json");

/** Where a session's transcript goes: ~/.loopway/threads/<session>.log */
export const sessionLogPath = (dir: string, sessionId: string) => join(dir, "threads", `${sessionId}.log`);

export async function loadSessions(dir: string): Promise<Sessions> {
  return ((await readJson(threadsPath(dir))) as Sessions | undefined) ?? {};
}

export async function saveSessions(dir: string, sessions: Sessions): Promise<void> {
  await writeJson(threadsPath(dir), sessions);
}

/** Loads, applies `fn` to the session, stamps updated_at, and saves. */
export async function updateSession(dir: string, id: string, fn: (s: Session) => void): Promise<Session | undefined> {
  const sessions = await loadSessions(dir);
  const s = sessions[id];
  if (!s) return undefined;
  fn(s);
  s.updated_at = new Date().toISOString();
  await saveSessions(dir, sessions);
  return s;
}

export function findSession(sessions: Sessions, inboxId: string, key: string): string | undefined {
  return Object.keys(sessions).find((id) => sessions[id]!.inbox_id === inboxId && sessions[id]!.keys.includes(key));
}
