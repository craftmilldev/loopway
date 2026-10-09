import type { Bot, LoopwayClient } from "../client.js";
import { authedClient, UsageError, type Context } from "../context.js";
import { ago, bold, dim, fields, json, table } from "../format.js";
import { BOT_KINDS } from "../bots/kinds.js";
import { resolveInbox } from "./inboxes.js";

interface JsonOpt {
  json?: boolean;
}

export async function listBots(ctx: Context, opts: JsonOpt) {
  const client = await authedClient(ctx);
  const bots = await client.listBots();
  if (opts.json) return ctx.out(json(bots));
  if (!bots.length) return ctx.out("No bots yet. Create one with `loopway bots create`.");
  const names = await inboxNames(client);
  ctx.out(
    table(
      ["ID", "NAME", "KIND", "INBOXES", "CREATED"],
      bots.map((b) => [b.id, b.name, b.kind, inboxList(b, names), dim(ago(b.created_at))]),
    ),
  );
}

export async function showBot(ctx: Context, ref: string, opts: JsonOpt) {
  const client = await authedClient(ctx);
  const bot = await client.getBot(await resolveBot(client, ref));
  if (opts.json) return ctx.out(json(bot));
  ctx.out(describe(bot, await inboxNames(client)));
}

export async function createBot(ctx: Context, opts: JsonOpt & { name?: string; kind?: string; inbox?: string[] }) {
  if (!opts.name) throw new UsageError("--name is required");
  if (!opts.kind) throw new UsageError(`--kind is required (${Object.keys(BOT_KINDS).join(", ")})`);
  if (!opts.inbox?.length) throw new UsageError("--inbox is required");
  const client = await authedClient(ctx);
  const bot = await client.createBot({
    name: opts.name,
    kind: opts.kind,
    inbox_ids: await resolveInboxes(client, opts.inbox),
  });
  if (opts.json) return ctx.out(json(bot));
  ctx.out(`Created bot ${bold(bot.name)} (${bot.id})\n\n${describe(bot, await inboxNames(client))}`);
}

export async function updateBot(ctx: Context, ref: string, opts: JsonOpt & { name?: string; inbox?: string[] }) {
  if (!opts.name && !opts.inbox) throw new UsageError("Pass --name or --inbox");
  if (opts.inbox && !opts.inbox.length) throw new UsageError("--inbox needs at least one inbox");
  const client = await authedClient(ctx);
  const id = await resolveBot(client, ref);
  const bot = await client.updateBot(id, {
    name: opts.name,
    inbox_ids: opts.inbox && (await resolveInboxes(client, opts.inbox)),
  });
  if (opts.json) return ctx.out(json(bot));
  ctx.out(`Updated bot ${bold(bot.name)} (${bot.id})\n\n${describe(bot, await inboxNames(client))}`);
}

export async function deleteBot(ctx: Context, ref: string) {
  const client = await authedClient(ctx);
  const id = await resolveBot(client, ref);
  await client.deleteBot(id);
  ctx.out(`Deleted bot ${id}.`);
}

/** What the bot would read next: messages after its cursor, oldest first. */
export async function botMessages(ctx: Context, ref: string, opts: JsonOpt & { limit?: number }) {
  const client = await authedClient(ctx);
  const messages = await client.botMessages(await resolveBot(client, ref), { limit: opts.limit });
  if (opts.json) return ctx.out(json(messages));
  if (!messages.length) return ctx.out("No new messages.");
  const names = await inboxNames(client);
  ctx.out(
    table(
      ["SEQ", "ID", "INBOX", "TYPE", "SUBJECT", "RECEIVED"],
      messages.map((m) => [
        String(m.seq),
        m.id,
        names.get(m.inbox_id) ?? m.inbox_id,
        m.event.type,
        m.event.subject ?? "",
        dim(ago(m.received_at)),
      ]),
    ),
  );
}

function describe(bot: Bot, names: Map<string, string>): string {
  return [
    bold(bot.name),
    fields([
      ["id", bot.id],
      ["kind", bot.kind],
      ["inboxes", inboxList(bot, names)],
      ["cursor", bot.cursor],
      ["created", `${bot.created_at} ${dim(`(${ago(bot.created_at)})`)}`],
    ]),
  ].join("\n");
}

async function inboxNames(client: LoopwayClient) {
  return new Map((await client.listInboxes()).map((i) => [i.id, i.name]));
}

const inboxList = (bot: Bot, names: Map<string, string>) => bot.inbox_ids.map((id) => names.get(id) ?? id).join(", ");

async function resolveInboxes(client: LoopwayClient, refs: string[]) {
  const ids: string[] = [];
  for (const ref of refs) ids.push(await resolveInbox(client, ref));
  return ids;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Commands take a bot id or an exact bot name. */
export async function resolveBot(client: LoopwayClient, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const matches = (await client.listBots()).filter((b) => b.name === ref);
  if (matches.length === 1) return matches[0]!.id;
  if (!matches.length) throw new UsageError(`No bot with id or name "${ref}". See \`loopway bots list\`.`);
  throw new UsageError(
    `Several bots are named "${ref}"; use an id instead:\n${matches.map((b) => `  ${b.id}`).join("\n")}`,
  );
}
