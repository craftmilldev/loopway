import * as p from "@clack/prompts";
import type { LoopwayClient, RegisteredSource } from "../client.js";
import { authedClient, CancelledError, UsageError, type Context } from "../context.js";
import { ago, bold, dim, fields, json, table } from "../format.js";
import { applyScheduleFlags, scheduleText, type ScheduleConfig, type ScheduleFlags } from "./schedule.js";

const SCHEDULE_FLAGS = ["every", "hour", "day", "message", "messageFile", "removeMessage", "config"] as const;

interface JsonOpt {
  json?: boolean;
}

/** Shows the inbox URL: the one address every sender is given. */
export async function showInbox(ctx: Context, opts: JsonOpt) {
  const inbox = await (await authedClient(ctx)).inbox();
  if (opts.json) return ctx.out(json(inbox));
  ctx.out(
    fields([
      ["url", inbox.url],
      ["sources", inbox.sources],
      ["messages", inbox.messages],
      ["kept for", `${inbox.retention_days} days`],
    ]),
  );
}

export async function listTypes(ctx: Context, opts: JsonOpt) {
  const types = await (await authedClient(ctx)).sourceTypes();
  if (opts.json) return ctx.out(json(types));
  ctx.out(
    table(
      ["TYPE", "SECRET", "DESCRIPTION"],
      types.map((s) => [s.type, s.secret.from, s.description]),
    ),
  );
}

export async function listSources(ctx: Context, opts: JsonOpt) {
  const rows = await (await authedClient(ctx)).listSources();
  if (opts.json) return ctx.out(json(rows));
  if (!rows.length) return ctx.out("No sources yet. Register one with `loopway source register <type>`.");
  ctx.out(
    table(
      ["NAME", "TYPE", "SECRET", "LAST DELIVERY"],
      rows.map((s) => [
        s.name,
        s.type,
        s.secret_set === undefined ? "-" : s.secret_set ? "set" : "not set",
        s.last_delivery_at ? `${ago(s.last_delivery_at)} (${s.last_delivery_outcome})` : "never",
      ]),
    ),
  );
}

export async function showSource(ctx: Context, ref: string, opts: JsonOpt) {
  const client = await authedClient(ctx);
  const source = await client.getSource(await resolveSource(client, ref));
  if (opts.json) return ctx.out(json(source));
  ctx.out(`${bold(source.name)}\n${describe(source)}`);
}

export interface RegisterOptions extends ScheduleFlags, JsonOpt {
  name?: string;
  secret?: string;
}

/** Registers a sender's secret, or a schedule, against the user's one inbox. */
export async function registerSource(ctx: Context, type: string, opts: RegisterOptions) {
  const client = await authedClient(ctx);
  const config = type === "schedule" ? scheduleConfigFrom(opts) : undefined;
  if (type !== "schedule" && SCHEDULE_FLAGS.some((f) => opts[f] !== undefined)) {
    throw new UsageError("The schedule flags only apply to `source register schedule`");
  }
  const source = await client.registerSource({ type, name: opts.name, secret: opts.secret, config });
  await ctx.metrics?.capture("source_registered", { source_type: source.type });
  if (opts.json) return ctx.out(json(source));
  ctx.out(`Registered ${bold(source.name)}\n${describe(source)}${nextStep(source)}`);
}

function scheduleConfigFrom(opts: ScheduleFlags): ScheduleConfig {
  if (!SCHEDULE_FLAGS.some((f) => opts[f] !== undefined)) {
    throw new UsageError("A schedule needs --every and at least one --message (or --config <file>)");
  }
  return applyScheduleFlags({} as ScheduleConfig, opts);
}

export interface UpdateOptions extends ScheduleFlags, JsonOpt {
  name?: string;
  secret?: string;
}

export async function updateSource(ctx: Context, ref: string, opts: UpdateOptions) {
  const client = await authedClient(ctx);
  const id = await resolveSource(client, ref);
  const current = await client.getSource(id);
  const scheduleFlags = SCHEDULE_FLAGS.some((f) => opts[f] !== undefined);
  if (scheduleFlags && current.type !== "schedule") {
    throw new UsageError(`The schedule flags don't apply to a ${current.type} source`);
  }
  const config = scheduleFlags ? applyScheduleFlags(current.config as ScheduleConfig, opts) : undefined;
  let secret = opts.secret;
  if (!opts.name && !secret && !config) {
    if (!ctx.interactive || current.type === "schedule") throw new UsageError("Nothing to change: pass a flag");
    secret = await promptSecret();
  }
  const updated = await client.updateSource(id, { name: opts.name, secret, config });
  if (opts.json) return ctx.out(json(updated));
  ctx.out(`Updated ${bold(updated.name)}\n${describe(updated)}`);
}

export async function removeSource(ctx: Context, ref: string) {
  const client = await authedClient(ctx);
  await client.removeSource(await resolveSource(client, ref));
  ctx.out(`Removed ${ref}. Its messages stay until they expire.`);
}

function describe(source: RegisteredSource): string {
  if (source.type === "schedule") return scheduleText(source.config as Partial<ScheduleConfig>);
  return fields([
    ["type", source.type],
    ["webhook url", source.webhook_url],
    ["secret", source.secret ?? (source.secret_set ? "set" : "not set")],
    ["add it in", source.webhook_settings],
    [
      "last delivery",
      source.last_delivery_at ? `${ago(source.last_delivery_at)} (${source.last_delivery_outcome})` : "none yet",
    ],
  ]);
}

/**
 * What's left to do after registering. Most senders do nothing until the webhook is added there, and some only show
 * their secret once it has been.
 */
export function nextStep(source: RegisteredSource): string {
  if (source.type === "github") {
    const gh =
      `gh api repos/OWNER/REPO/hooks -f name=web -F active=true -f 'config[url]=${source.webhook_url}'` +
      ` -f 'config[content_type]=json' -f 'config[secret]=${source.secret ?? "SECRET"}' -f 'events[]=*'`;
    return `\n\n${dim("Shown once.")} GitHub sends nothing until the webhook is added. Add it in ${source.webhook_settings}, or run:\n  ${gh}`;
  }
  if (source.secret) return `\n\n${dim("That secret is shown once.")}`;
  if (source.secret_set === false) {
    return `\n\nAdd the webhook URL in ${source.webhook_settings}, then give loopway the secret it shows:\n  loopway source update ${source.name} --secret <secret>\nDeliveries are refused until you do.`;
  }
  return "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Commands take a source's id or its name. */
async function resolveSource(client: LoopwayClient, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const match = (await client.listSources()).find((s) => s.name === ref);
  if (!match) throw new UsageError(`No source with id or name "${ref}". See \`loopway source list\`.`);
  return match.id;
}

async function promptSecret() {
  const v = await p.password({ message: "Signing secret" });
  if (p.isCancel(v)) throw new CancelledError();
  return v.trim();
}
