import { ApiError, type ImportThread } from "../client.js";
import { authedClient, type Context } from "../context.js";
import { dim, json, table } from "../format.js";
import { adoptSessions, loadSessions, type Session } from "../threads/store.js";
import { resolveBot } from "./bots.js";

/** `loopway bots threads <bot>`: the threads the server has for a bot. */
export async function listBotThreads(ctx: Context, ref: string, opts: { status?: string; json?: boolean }) {
  const client = await authedClient(ctx);
  const status = (opts.status ?? "active") as "active" | "ended" | "all";
  const threads = await client.listThreads(await resolveBot(client, ref), status);
  if (opts.json) return ctx.out(json(threads));
  if (!threads.length) return ctx.out(status === "all" ? "No threads." : `No ${status} threads.`);
  ctx.out(
    table(
      ["ID", "STATUS", "KEYS", "WAITING", "INFLIGHT", "DELIVERED"],
      threads.map((t) => [
        t.id,
        t.status,
        t.keys.join(", "),
        String(t.waiting.length),
        String(t.inflight.length),
        String(t.delivered),
      ]),
    ),
  );
}

/**
 * `loopway bots threads import`: uploads the sessions in threads.json the server doesn't have yet. threads.json
 * is left as it is, and `bots run` still uses it.
 */
export async function importBotThreads(ctx: Context, opts: { bot?: string }) {
  const client = await authedClient(ctx);
  const all = await client.listBots();
  const only = opts.bot && (await resolveBot(client, opts.bot));
  const bots = only ? all.filter((b) => b.id === only) : all;
  const sessions = await loadSessions(ctx.configDir);
  adoptSessions(sessions, all);

  let imported = 0;
  let present = 0;
  for (const bot of bots) {
    const have = new Set((await client.listThreads(bot.id, "all")).map((t) => t.id));
    for (const [id, session] of Object.entries(sessions)) {
      if (session.bot_id !== bot.id) continue;
      if (have.has(id)) {
        present++;
        continue;
      }
      try {
        const { skipped } = await client.importThread(bot.id, toImport(id, session));
        imported++;
        if (skipped) ctx.out(dim(`${id}: ${skipped} message(s) no longer exist or belong to another thread; skipped.`));
      } catch (err) {
        if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500) throw err;
        ctx.out(`Skipped ${id} (${bot.name}): ${err.message}`);
      }
    }
  }
  ctx.out(`Imported ${imported} thread(s); ${present} already on the server.`);
}

function toImport(id: string, s: Session): ImportThread {
  const seen = new Set<string>();
  const messages: ImportThread["messages"] = [];
  const add = (mid: string, state: ImportThread["messages"][number]["state"], key?: string) => {
    if (seen.has(mid)) return;
    seen.add(mid);
    messages.push({ id: mid, state, ...(key ? { key } : {}) });
  };
  for (const m of s.messages) add(m, "delivered");
  for (const m of s.inflight ?? []) add(m.id, "inflight", m.key);
  for (const m of s.waiting) add(m.id, "waiting", m.key);
  return {
    id,
    keys: s.keys,
    status: s.status,
    started: s.started,
    interrupted: !!s.interrupted,
    limited: !!s.limited,
    messages,
  };
}
