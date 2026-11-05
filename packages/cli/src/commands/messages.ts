import { readFileSync } from "node:fs";
import type { Message } from "../client.js";
import { authedClient, UsageError, type Context } from "../context.js";
import { ago, bold, dim, fields, json, table } from "../format.js";
import { sinceValue } from "./read.js";

interface JsonOpt {
  json?: boolean;
}

/** Without --since, the newest messages. With it, everything from that time, a page at a time unless --all. */
export async function listMessages(
  ctx: Context,
  opts: JsonOpt & { since?: string; type?: string; limit?: number; all?: boolean },
) {
  const client = await authedClient(ctx);
  const { type, limit = 20 } = opts;
  let messages: Message[];
  let more = false;
  if (opts.since === undefined) {
    messages = (await client.readMessages({ order: "desc", limit, type })).data;
  } else {
    let page = await client.readMessages({ since: sinceValue(opts.since), limit, type });
    messages = [...page.data];
    while (opts.all && page.has_more) {
      page = await client.readMessages({ since: page.next_since!, after: page.next_after ?? undefined, limit, type });
      messages.push(...page.data);
    }
    more = page.has_more;
  }
  if (opts.json) return ctx.out(json(messages));
  if (!messages.length) return ctx.out("No messages.");
  ctx.out(
    table(
      ["ID", "TYPE", "SUBJECT", "RECEIVED"],
      messages.map((e) => [e.id, e.event.type, e.event.subject ?? "", dim(ago(e.received_at))]),
    ),
  );
  if (more) ctx.out(dim("\nMore messages: add --all"));
}

export async function getMessage(ctx: Context, id: string, opts: JsonOpt & { data?: boolean }) {
  const e = await (await authedClient(ctx)).getMessage(id);
  if (opts.data) return ctx.out(json(e.event.data ?? null));
  if (opts.json) return ctx.out(json(e));
  ctx.out(`${describe(e)}\n\n${json(e.event.data ?? null)}`);
}

export interface PushOptions extends JsonOpt {
  subject?: string;
  id?: string;
  data?: string;
  dataFile?: string;
}

/** Puts a message in the user's inbox. */
export async function pushMessage(ctx: Context, type: string, opts: PushOptions) {
  if (opts.data !== undefined && opts.dataFile !== undefined)
    throw new UsageError("Give --data or --data-file, not both");
  const raw = opts.dataFile === undefined ? opts.data : readFileOrThrow(opts.dataFile);
  let data: unknown;
  if (raw !== undefined) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new UsageError("The message's data must be JSON");
    }
  }
  const client = await authedClient(ctx);
  const stored = await client.pushMessage({ type, subject: opts.subject, id: opts.id, data });
  if (opts.json) return ctx.out(json(stored));
  ctx.out(stored.duplicate ? `Already stored as ${stored.id}` : `Pushed ${stored.id}`);
}

function readFileOrThrow(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
