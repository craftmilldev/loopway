import { readFile } from "node:fs/promises";
import type { Bot, BotRule, LoopwayClient } from "../client.js";
import { authedClient, UsageError, type Context } from "../context.js";
import { ago, bold, dim, fields, json, table } from "../format.js";
import { BOT_KINDS } from "../bots/kinds.js";
import { checkRules } from "@loopway/rules";
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
      ["ID", "NAME", "KIND", "MODEL", "INBOXES", "CREATED"],
      bots.map((b) => [b.id, b.name, b.kind, b.model, inboxList(b, names), dim(ago(b.created_at))]),
    ),
  );
}

export async function showBot(ctx: Context, ref: string, opts: JsonOpt & { prompt?: boolean; rules?: boolean }) {
  const client = await authedClient(ctx);
  const bot = await client.getBot(await resolveBot(client, ref));
  if (opts.prompt || opts.rules) {
    const version = bot.prompt_version;
    if (!version) throw new UsageError(`Bot ${bot.name} has no version yet.`);
    if (opts.prompt && opts.rules) throw new UsageError("Pass --prompt or --rules, not both.");
    return ctx.out(opts.prompt ? version.prompt : json(version.rules ?? []));
  }
  if (opts.json) return ctx.out(json(bot));
  ctx.out(describe(bot, await inboxNames(client)));
}

/** `loopway bots versions <bot>`: every saved version of the bot's prompt and rules, newest first. */
export async function botVersions(ctx: Context, ref: string, opts: JsonOpt) {
  const client = await authedClient(ctx);
  const versions = await client.listBotVersions(await resolveBot(client, ref));
  if (opts.json) return ctx.out(json(versions));
  if (!versions.length) return ctx.out("No versions yet.");
  ctx.out(
    table(
      ["VERSION", "RULES", "PROMPT", "SAVED"],
      versions.map((v) => [
        String(v.version),
        v.rules ? String(v.rules.length) : "none",
        `${v.prompt.length} chars`,
        dim(ago(v.created_at)),
      ]),
    ),
  );
}

/**
 * `loopway bots edit <bot>`: saves a new version with the prompt and/or rules read from files. What isn't given
 * carries over from the current version. The rules are checked before saving, so a bad edit is caught here.
 */
export async function editBot(ctx: Context, ref: string, opts: JsonOpt & { promptFile?: string; rulesFile?: string }) {
  if (!opts.promptFile && !opts.rulesFile) throw new UsageError("Pass --prompt-file or --rules-file");
  const client = await authedClient(ctx);
  const bot = await client.getBot(await resolveBot(client, ref));
  const prompt = opts.promptFile ? (await readFile(opts.promptFile, "utf8")).trimEnd() : bot.prompt_version?.prompt;
  if (!prompt) throw new UsageError(`Bot ${bot.name} has no prompt yet; pass --prompt-file.`);
  let rules: BotRule[] | undefined;
  if (opts.rulesFile) {
    const text = await readFile(opts.rulesFile, "utf8");
    try {
      rules = JSON.parse(text) as BotRule[];
      checkRules(rules);
    } catch (err) {
      throw new UsageError(`${opts.rulesFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const version = await client.addBotVersion(bot.id, prompt, rules);
  if (opts.json) return ctx.out(json(version));
  ctx.out(
    `Saved version ${version.version} of bot ${bold(bot.name)}. A running \`loopway bots run\` picks it up on its next poll.`,
  );
}

export async function createBot(
  ctx: Context,
  opts: JsonOpt & { name?: string; kind?: string; model?: string; inbox?: string[] },
) {
  if (!opts.name) throw new UsageError("--name is required");
  if (!opts.kind) throw new UsageError(`--kind is required (${Object.keys(BOT_KINDS).join(", ")})`);
  if (!opts.model) throw new UsageError("--model is required (an alias like sonnet or opus, or a full model id)");
  if (!opts.inbox?.length) throw new UsageError("--inbox is required");
  const client = await authedClient(ctx);
  const bot = await client.createBot({
    name: opts.name,
    kind: opts.kind,
    model: opts.model,
    inbox_ids: await resolveInboxes(client, opts.inbox),
    prompt: await BOT_KINDS[opts.kind]?.prompt(),
    rules: BOT_KINDS[opts.kind]?.rules,
  });
  if (opts.json) return ctx.out(json(bot));
  ctx.out(`Created bot ${bold(bot.name)} (${bot.id})\n\n${describe(bot, await inboxNames(client))}`);
}

export async function updateBot(
  ctx: Context,
  ref: string,
  opts: JsonOpt & { name?: string; model?: string; inbox?: string[] },
) {
  if (!opts.name && !opts.model && !opts.inbox) throw new UsageError("Pass --name, --model or --inbox");
  if (opts.inbox && !opts.inbox.length) throw new UsageError("--inbox needs at least one inbox");
  const client = await authedClient(ctx);
  const id = await resolveBot(client, ref);
  const bot = await client.updateBot(id, {
    name: opts.name,
    model: opts.model,
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

/** `loopway bots release <bot> --force`: drops the lease a runner left behind when it died. */
export async function releaseBot(ctx: Context, ref: string, opts: { force?: boolean }) {
  if (!opts.force) {
    throw new UsageError(
      "Pass --force to drop the lease. A `loopway bots run` still holding it loses the bot to the next runner.",
    );
  }
  const client = await authedClient(ctx);
  const id = await resolveBot(client, ref);
  await client.forceReleaseBot(id);
  ctx.out(`Released the lease on bot ${id}; the next \`loopway bots run\` can take it.`);
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
      ["model", bot.model],
      ["prompt", bot.prompt_version ? `version ${bot.prompt_version.version}` : "none"],
      ["rules", bot.prompt_version?.rules ? String(bot.prompt_version.rules.length) : "none"],
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
