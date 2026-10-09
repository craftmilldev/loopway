import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readJson, writeJson } from "../config.js";

/**
 * Agent sessions started by `loopway bots run`, kept in ~/.loopway/threads.json keyed by session id.
 * A session owns a thread: the issues and PRs in `keys` (`owner/repo#number`).
 */
export interface Session {
  bot_id: string;
  /** Set instead of bot_id by versions that ran one inbox; a bot reading that inbox adopts the session. */
  inbox_id?: string;
  keys: string[];
  /** Messages delivered to the session, as event ids. */
  events: string[];
  /** Messages assigned to the session but not delivered yet: its run is in flight, or --max is reached. */
  waiting: WaitingMessage[];
  /** `ended` once the session calls its `end` tool; a new event for the thread makes it active again. */
  status: "active" | "ended";
  /** Whether a claude session with this id exists yet (first run uses --session-id, later ones --resume). */
  started: boolean;
  /** Set when the last run stopped at the usage limit after taking its messages: the next run resumes it. */
  limited?: true;
  /** Set when the last run took its messages, then ended on an API error: the next run resumes it. */
  interrupted?: true;
  created_at: string;
  updated_at: string;
}

/** Enough about an assigned message to deliver it without fetching it again. */
export interface WaitingMessage {
  id: string;
  inbox_id: string;
  type: string;
  key?: string;
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
    // Write then rename, so loadSessions() (which doesn't take the lock) never sees a half-written file.
    const tmp = `${threadsPath(dir)}.tmp`;
    await writeJson(tmp, sessions);
    await rename(tmp, threadsPath(dir));
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
      const mtime = await stat(path).then(
        (s) => s.mtimeMs,
        () => Date.now(),
      );
      if (Date.now() - mtime > staleMs) await rm(path, { force: true });
      else await sleep(10);
    }
  }
}

export function findSession(sessions: Sessions, botId: string, key: string): string | undefined {
  return Object.keys(sessions).find((id) => sessions[id]!.bot_id === botId && sessions[id]!.keys.includes(key));
}

/**
 * Gives sessions written before bots existed (`inbox_id`, no `bot_id`) to the bot that reads that
 * inbox, so threads in flight carry on. Those sessions have no `waiting` list yet either.
 */
export function adoptSessions(sessions: Sessions, bots: { id: string; inbox_ids: string[] }[]): number {
  let adopted = 0;
  for (const s of Object.values(sessions)) {
    s.waiting ??= [];
    if (s.bot_id || !s.inbox_id) continue;
    const bot = bots.find((b) => b.inbox_ids.includes(s.inbox_id!));
    if (!bot) continue;
    s.bot_id = bot.id;
    delete s.inbox_id;
    adopted++;
  }
  return adopted;
}

/** The session with this id, for changes inside withSessions(); stamps updated_at. */
export function editSession(sessions: Sessions, id: string): Session {
  const s = sessions[id];
  if (!s) throw new Error(`No session ${id}.`);
  s.updated_at = new Date().toISOString();
  return s;
}
