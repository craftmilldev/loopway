import type { Event, ListEventsQuery, LockedEvent } from "../client.js";
import { authedClient, UsageError, type Context } from "../context.js";
import { ago, bold, dim, fields, json, status, table } from "../format.js";
import { forgetLock, heldToken, rememberLock } from "../locks.js";
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
      ["ID", "STATUS", "TYPE", "SUBJECT", "RECEIVED"],
      events.map((e) => [e.id, status(e.status), e.event.type, e.event.subject ?? "", dim(ago(e.received_at))]),
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

export async function nextEvent(ctx: Context, inboxRef: string, opts: JsonOpt & { ttl?: number }) {
  const client = await authedClient(ctx);
  const inboxId = await resolveInbox(client, inboxRef);
  const e = await client.next(inboxId, { ttl_seconds: opts.ttl });
  if (!e) {
    // Empty stdout in --json mode, like the API's 204, so scripts can test for it.
    if (!opts.json) ctx.out("No events waiting.");
    return;
  }
  await rememberLock(ctx.configDir, e);
  if (opts.json) return ctx.out(json(e));
  ctx.out(`${describe(e)}\n\n${json(e.event.data ?? null)}`);
  ctx.out(dim(`\nWhen you're done: loopway events done ${inboxRef} ${e.id}`));
}

export async function lockEvent(ctx: Context, inboxRef: string, eventId: string, opts: JsonOpt & LockOpts) {
  const client = await authedClient(ctx);
  const inboxId = await resolveInbox(client, inboxRef);
  // Passing the token we already hold renews our lock instead of failing with 409 locked.
  const token = opts.token ?? (await heldToken(ctx.configDir, inboxId, eventId));
  const e = await client.lock(inboxId, eventId, { ttl_seconds: opts.ttl, lock_token: token });
  await rememberLock(ctx.configDir, e);
  if (opts.json) return ctx.out(json(e));
  ctx.out(describe(e));
}

export async function unlockEvent(ctx: Context, inboxRef: string, eventId: string, opts: JsonOpt & LockOpts) {
  const client = await authedClient(ctx);
  const inboxId = await resolveInbox(client, inboxRef);
  const token = opts.token ?? (await heldToken(ctx.configDir, inboxId, eventId));
  if (!token) throw new UsageError("This machine doesn't hold a lock on that event; pass --token <lock_token>.");
  const e = await client.unlock(inboxId, eventId, token);
  await forgetLock(ctx.configDir, eventId);
  if (opts.json) return ctx.out(json(e));
  ctx.out(`Unlocked ${e.id}; it's ${status(e.status)} again.`);
}

export async function markProcessed(ctx: Context, inboxRef: string, eventId: string, opts: JsonOpt & LockOpts) {
  const client = await authedClient(ctx);
  const inboxId = await resolveInbox(client, inboxRef);
  const token = opts.token ?? (await heldToken(ctx.configDir, inboxId, eventId));
  const e = await client.processed(inboxId, eventId, { lock_token: token });
  await forgetLock(ctx.configDir, eventId);
  if (opts.json) return ctx.out(json(e));
  ctx.out(`Marked ${e.id} ${status(e.status)}.`);
}

interface LockOpts {
  ttl?: number;
  token?: string;
}

function describe(e: Event | LockedEvent): string {
  const lock = "lock" in e ? e.lock : undefined;
  return [
    `${bold(e.event.type)} ${status(e.status)}`,
    fields([
      ["id", e.id],
      ["subject", e.event.subject],
      ["source", e.event.source],
      ["time", e.event.time],
      ["received", `${e.received_at} ${dim(`(${ago(e.received_at)})`)}`],
      ["locked until", e.locked_until && `${e.locked_until} ${dim(`(${ago(e.locked_until)})`)}`],
      ["processed", e.processed_at],
      ["claims", e.lock_count],
      ["lock token", lock?.token],
    ]),
  ].join("\n");
}
