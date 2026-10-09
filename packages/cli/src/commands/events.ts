import type { Event, ListEventsQuery } from "../client.js";
import { authedClient, type Context } from "../context.js";
import { ago, bold, dim, fields, json, table } from "../format.js";
import { resolveInbox } from "./inboxes.js";

interface JsonOpt {
  json?: boolean;
}

export async function listEvents(ctx: Context, inboxRef: string, opts: ListEventsQuery & JsonOpt & { all?: boolean }) {
  const client = await authedClient(ctx);
  const inboxId = await resolveInbox(client, inboxRef);
  const { json: asJson, all, ...query } = opts;

  let page = await client.listEvents(inboxId, query);
  const events = [...page.data];
  while (all && page.next_cursor) {
    page = await client.listEvents(inboxId, { ...query, cursor: page.next_cursor });
    events.push(...page.data);
  }
  if (asJson) return ctx.out(json({ data: events, next_cursor: page.next_cursor }));

  if (!events.length) return ctx.out(query.cursor ? "No more events." : "No events.");
  ctx.out(
    table(
      ["ID", "TYPE", "SUBJECT", "RECEIVED"],
      events.map((e) => [e.id, e.event.type, e.event.subject ?? "", dim(ago(e.received_at))]),
    ),
  );
  if (page.next_cursor) ctx.out(dim(`\nMore events: add --cursor ${page.next_cursor} (or --all)`));
}

export async function getEvent(ctx: Context, inboxRef: string, eventId: string, opts: JsonOpt & { data?: boolean }) {
  const client = await authedClient(ctx);
  const e = await client.getEvent(await resolveInbox(client, inboxRef), eventId);
  if (opts.data) return ctx.out(json(e.event.data ?? null));
  if (opts.json) return ctx.out(json(e));
  ctx.out(`${describe(e)}\n\n${json(e.event.data ?? null)}`);
}

function describe(e: Event): string {
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
