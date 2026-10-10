import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { ImportThread, LoopwayClient } from "../client.js";
import { readJson } from "../config.js";
import { UsageError } from "../context.js";

/** A session in ~/.loopway/threads.json, from before threads lived on the server. */
interface Session {
  bot_id?: string;
  /** Set instead of bot_id by versions that ran one inbox; the bot reading that inbox adopts the session. */
  inbox_id?: string;
  keys: string[];
  /** Delivered message ids; `events` in files from before events became messages. */
  messages?: string[];
  events?: string[];
  waiting?: LegacyMessage[];
  inflight?: LegacyMessage[];
  status: "active" | "ended";
  started: boolean;
  interrupted?: true;
  limited?: true;
}

interface LegacyMessage {
  id: string;
  key?: string;
}

/**
 * Moves threads.json to the server, once. `bots run` calls it at startup, after it has leased its runner, and
 * the file is never read again: it's renamed to threads.json.imported.
 *
 * Each session of the given bots becomes a thread owned by this runner. One the server doesn't have is created;
 * one it has and this runner owns is refreshed from the file, which is newer than any earlier `bots threads
 * import`. One owned by another runner, or by none, is left as the server has it. A failure leaves the file in
 * place and stops with a UsageError, so the next start tries again.
 *
 * Returns how many threads it wrote.
 */
export async function importLegacyThreads(
  dir: string,
  client: LoopwayClient,
  bots: { id: string; name: string; inbox_ids: string[] }[],
  runnerId: string,
): Promise<number> {
  const path = join(dir, "threads.json");
  const sessions = (await readJson(path)) as Record<string, Session> | undefined;
  if (!sessions) return 0;

  let written = 0;
  for (const bot of bots) {
    const have = new Map((await client.listThreads(bot.id, "all")).map((t) => [t.id, t]));
    for (const [id, s] of Object.entries(sessions)) {
      const owner = s.bot_id ?? bots.find((b) => b.inbox_ids.includes(s.inbox_id ?? ""))?.id;
      if (owner !== bot.id) continue;
      const existing = have.get(id);
      if (existing && existing.runner_id !== runnerId) continue;
      try {
        await client.importThread(bot.id, { ...toImport(id, s), runner_id: runnerId, refresh: !!existing });
        written++;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new UsageError(
          `Couldn't import ${id} (${bot.name}) from threads.json: ${why} It stays in place; fix that and start again.`,
          { cause: err },
        );
      }
    }
  }
  await rename(path, `${path}.imported`);
  return written;
}

function toImport(id: string, s: Session): ImportThread {
  const seen = new Set<string>();
  const messages: ImportThread["messages"] = [];
  const add = (mid: string, state: ImportThread["messages"][number]["state"], subject?: string) => {
    if (seen.has(mid)) return;
    seen.add(mid);
    messages.push({ id: mid, state, ...(subject ? { subject } : {}) });
  };
  for (const m of s.messages ?? s.events ?? []) add(m, "delivered");
  for (const m of s.inflight ?? []) add(m.id, "inflight", m.key);
  for (const m of s.waiting ?? []) add(m.id, "waiting", m.key);
  return {
    id,
    subjects: s.keys,
    status: s.status,
    started: s.started,
    interrupted: !!s.interrupted,
    limited: !!s.limited,
    messages,
  };
}
