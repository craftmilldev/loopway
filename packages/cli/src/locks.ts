import { join } from "node:path";
import type { LockedEvent } from "./client.js";
import { readJson, writeJson } from "./config.js";

/**
 * Lock tokens this machine is holding, so `events done`/`unlock`/`lock` (renew) work without
 * passing --token. Kept in ~/.loopway/locks.json, keyed by event id; expired entries are dropped.
 */
interface HeldLock {
  inbox_id: string;
  token: string;
  expires_at: string;
}

type Locks = Record<string, HeldLock>;

const locksPath = (dir: string) => join(dir, "locks.json");

async function load(dir: string, now = Date.now()): Promise<Locks> {
  const raw = (await readJson(locksPath(dir))) as Locks | undefined;
  const live: Locks = {};
  for (const [id, l] of Object.entries(raw ?? {})) {
    if (l && typeof l.token === "string" && Date.parse(l.expires_at) > now) live[id] = l;
  }
  return live;
}

export async function heldToken(dir: string, inboxId: string, eventId: string): Promise<string | undefined> {
  const l = (await load(dir))[eventId];
  return l && l.inbox_id === inboxId ? l.token : undefined;
}

export async function rememberLock(dir: string, e: LockedEvent): Promise<void> {
  const locks = await load(dir);
  locks[e.id] = { inbox_id: e.inbox_id, token: e.lock.token, expires_at: e.lock.expires_at };
  await writeJson(locksPath(dir), locks);
}

export async function forgetLock(dir: string, eventId: string): Promise<void> {
  const locks = await load(dir);
  if (!(eventId in locks)) return;
  delete locks[eventId];
  await writeJson(locksPath(dir), locks);
}
