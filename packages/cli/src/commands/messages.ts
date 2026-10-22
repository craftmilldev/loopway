import type { Message, ListMessagesQuery } from "../client.js";
import { authedClient, type Context } from "../context.js";
import { ago, bold, dim, fields, json, table } from "../format.js";
import { resolveInbox } from "./inboxes.js";

interface JsonOpt {
  json?: boolean;
}

export async function listMessages(
  ctx: Context,
  inboxRef: string,
  opts: ListMessagesQuery & JsonOpt & { all?: boolean; org?: string },
) {
  const client = await authedClient(ctx);
  const inboxId = await resolveInbox(ctx, client, inboxRef, opts.org);
  const { json: asJson, all, ...query } = opts;
  delete query.org;

  let page = await client.listMessages(inboxId, query);
  const messages = [...page.data];
  while (all && page.next_cursor) {
    page = await client.listMessages(inboxId, { ...query, cursor: page.next_cursor });
    messages.push(...page.data);
  }
  if (asJson) return ctx.out(json({ data: messages, next_cursor: page.next_cursor }));

  if (!messages.length) return ctx.out(query.cursor ? "No more messages." : "No messages.");
  ctx.out(
    table(
      ["ID", "TYPE", "SUBJECT", "RECEIVED"],
      messages.map((e) => [e.id, e.event.type, e.event.subject ?? "", dim(ago(e.received_at))]),
    ),
  );
  if (page.next_cursor) ctx.out(dim(`\nMore messages: add --cursor ${page.next_cursor} (or --all)`));
}

export async function getMessage(
  ctx: Context,
  inboxRef: string,
  messageId: string,
  opts: JsonOpt & { data?: boolean; org?: string },
) {
  const client = await authedClient(ctx);
  const e = await client.getMessage(await resolveInbox(ctx, client, inboxRef, opts.org), messageId);
  if (opts.data) return ctx.out(json(e.event.data ?? null));
  if (opts.json) return ctx.out(json(e));
  ctx.out(`${describe(e)}\n\n${json(e.event.data ?? null)}`);
}

function describe(e: Message): string {
  return [
    bold(e.event.type),
    fields([
      ["id", e.id],
      ["subject", e.event.subject],
      ["source", e.event.source],
      ["time", e.event.time],
      ["received", `${e.received_at} ${dim(`(${ago(e.received_at)})`)}`],
    ]),
  ].join("\n");
}
