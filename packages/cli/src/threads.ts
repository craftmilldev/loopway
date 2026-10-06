import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readJson, writeJson } from "./config.js";

/**
 * Agent sessions started by `loopway threads`, kept in ~/.loopway/threads.json keyed by session id.
 * A session owns a thread: the issues and PRs in `keys` (`owner/repo#number`).
 */
export interface Session {
  inbox_id: string;
  keys: string[];
  /** Events delivered to the session and not yet processed; the dispatcher keeps their locks alive. */
  events: string[];
  /** `ended` once the session calls its `end` tool; a new event for the thread makes it active again. */
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

/**
 * Loads threads.json, lets `fn` change it, and saves it, all while holding threads.json.lock. Every
 * write goes through here, so dispatchers for different inboxes (and overlapping work within one)
 * can't overwrite each other's changes.
 */
export async function withSessions<T>(dir: string, fn: (sessions: Sessions) => T): Promise<T> {
  const release = await lockFile(join(dir, "threads.json.lock"));
  try {
    const sessions = await loadSessions(dir);
    const result = fn(sessions);
    await writeJson(threadsPath(dir), sessions);
    return result;
  } finally {
    await release();
  }
}

/** A lock file created with O_EXCL; one left behind by a crashed holder is taken over once it's stale. */
async function lockFile(path: string, staleMs = 10_000): Promise<() => Promise<void>> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await (await open(path, "wx", 0o600)).close();
      return () => rm(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const mtime = await stat(path).then((s) => s.mtimeMs, () => Date.now());
      if (Date.now() - mtime > staleMs) await rm(path, { force: true });
      else await sleep(10);
    }
  }
}

export function findSession(sessions: Sessions, inboxId: string, key: string): string | undefined {
  return Object.keys(sessions).find((id) => sessions[id]!.inbox_id === inboxId && sessions[id]!.keys.includes(key));
}
