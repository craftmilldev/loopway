import * as p from "@clack/prompts";
import { readFileSync } from "node:fs";
import type { Inbox, LoopwayClient, Source } from "../client.js";
import { authedClient, CancelledError, UsageError, type Context } from "../context.js";
import { ago, bold, dim, fields, humanize, json, table } from "../format.js";

import { resolveOrg } from "./orgs.js";

// ---------- list / show ----------

export async function listInboxes(ctx: Context, opts: { json?: boolean }) {
  const inboxes = await (await authedClient(ctx)).listInboxes();
  if (opts.json) return ctx.out(json(inboxes));
  if (!inboxes.length) return ctx.out("No inboxes yet. Create one with `loopway inbox create`.");
  ctx.out(
    table(
      ["ID", "NAME", "SOURCE", "CREATED"],
      inboxes.map((i) => [i.id, i.name, i.source_type, dim(ago(i.created_at))]),
    ),
  );
}

export async function showInbox(ctx: Context, ref: string, opts: { json?: boolean }) {
  const client = await authedClient(ctx);
  const inbox = await client.getInbox(await resolveInbox(client, ref));
  if (opts.json) return ctx.out(json(inbox));
  const { stats } = inbox;
  ctx.out(
    [
      bold(inbox.name),
      fields([
        ["id", inbox.id],
        ["source", inbox.source_type],
        ["created", `${inbox.created_at} ${dim(`(${ago(inbox.created_at)})`)}`],
        ["messages", stats.messages],
      ]),
      "",
      inbox.source_type === "schedule" ? scheduleText(inbox.config) : setupText(inbox),
    ].join("\n"),
  );
}

// ---------- create ----------

export interface CreateOptions {
  org?: string;
  name?: string;
  source?: string;
  events?: string[];
  secret?: string;
  schema?: Record<string, unknown>;
  every?: string;
  hour?: number;
  message?: string[];
  messageFile?: string[];
  config?: ScheduleConfig;
  json?: boolean;
}

const OTHER = "__other__";

/**
 * Interactive: walks through name → source → events → secret → confirm, skipping any step whose
 * value came in as a flag. The steps come from the source's description (`GET /sources`), so no
 * source needs its own flow. Non-interactive (no TTY): flags only, so it can be scripted.
 */
export async function createInbox(ctx: Context, opts: CreateOptions) {
  const client = await authedClient(ctx);
  opts = { ...opts, org: await resolveOrg(ctx, client, opts.org, "inbox") };
  const inbox = ctx.interactive ? await createInteractive(ctx, client, opts) : await createFromFlags(ctx, client, opts);
  if (inbox.source_type === "schedule") await ctx.metrics?.capture("schedule_created", { how: scheduleHow(ctx, opts) });
  if (opts.json) return ctx.out(json(inbox));
  if (!ctx.interactive) {
    const body = inbox.source_type === "schedule" ? scheduleText(inbox.config) : setupText(inbox);
    ctx.out(`Created inbox ${bold(inbox.name)} (${inbox.id})\n\n${body}`);
  }
}

const scheduleHow = (ctx: Context, opts: CreateOptions) =>
  opts.config ? "file" : ctx.interactive ? "interactive" : "flags";

async function createFromFlags(ctx: Context, client: LoopwayClient, opts: CreateOptions) {
  if (!opts.name) throw new UsageError("--name is required when not running in a terminal");
  const source = opts.source ?? (await onlySource(client));
  if (!source) throw new UsageError("--source is required when not running in a terminal");
  if (source !== "schedule") {
    const scheduleFlags = SCHEDULE_FLAGS.filter(
      (f) => f !== "removeMessage" && opts[f as keyof CreateOptions] !== undefined,
    );
    if (scheduleFlags.length) {
      await ctx.metrics?.capture("inbox_create_rejected", { source, reason: "schedule_flag_on_other_source" });
      throw new UsageError("--every, --hour, --message, --message-file and --config only work with --source schedule");
    }
    return client.createInbox({ org: opts.org!, name: opts.name, source_type: source, config: flagConfig(opts) });
  }

  const reject = async (reason: string, message: string): Promise<never> => {
    await ctx.metrics?.capture("inbox_create_rejected", { source, reason });
    throw new UsageError(message);
  };
  if (opts.events || opts.secret || opts.schema) {
    return reject("webhook_flag_on_schedule", "--events, --secret and --schema don't apply to a schedule inbox");
  }
  let config: ScheduleConfig;
  try {
    config = applyScheduleFlags({ messages: [] } as unknown as ScheduleConfig, opts);
  } catch (err) {
    if (err instanceof ScheduleFlagError) return reject(err.reason, err.message);
    throw err;
  }
  if (!config.schedule)
    return reject("no_schedule", "A schedule inbox needs --every hour, or --every day with --hour <0-23>");
  return createScheduleInbox(ctx, client, opts.org!, opts.name, config);
}

async function createScheduleInbox(
  ctx: Context,
  client: LoopwayClient,
  org: string,
  name: string,
  config: ScheduleConfig,
) {
  try {
    return await client.createInbox({
      org,
      name,
      source_type: "schedule",
      config: config,
    });
  } catch (err) {
    await ctx.metrics?.capture("schedule_create_failed", { reason: "server_rejected" });
    throw err;
  }
}

async function createInteractive(ctx: Context, client: LoopwayClient, opts: CreateOptions): Promise<Inbox> {
  p.intro(bold(" New loopway inbox "));

  const name =
    opts.name ??
    ask(
      await p.text({
        message: "What should this inbox be called?",
        placeholder: "e.g. craftmill/loopway",
        validate: (v) => (!v?.trim() ? "A name is required" : v.length > 200 ? "200 characters max" : undefined),
      }),
    ).trim();

  const loading = p.spinner();
  loading.start("Loading sources");
  const sources = await client.sources().catch((err: unknown) => {
    loading.error("Could not load sources");
    throw err;
  });
  loading.clear();
  const type =
    opts.source ??
    ask(
      await p.select({
        message: "Where will messages come from?",
        options: sources
          .filter((s) => s.secret.from !== "none" || s.type === "schedule")
          .map((s) => ({ value: s.type, label: s.label, hint: s.description })),
      }),
    );
  const source = sources.find((s) => s.type === type);
  if (!source) throw new UsageError(`Unknown source "${type}". Available: ${sources.map((s) => s.type).join(", ")}`);

  if (source.type === "schedule") return createScheduleInteractive(ctx, client, opts, name);
  if (source.secret.from === "none") {
    throw new UsageError(
      `${source.label} inboxes are created through the API: POST /api/inboxes (see docs/sources/${source.type}.md)`,
    );
  }
  const config = await sourceConfig(source, opts);

  p.note(
    fields([
      ["name", name],
      ["source", source.type],
      ...Object.entries(config).map(([k, v]): [string, string] => [
        k,
        k === "secret"
          ? "(provided)"
          : Array.isArray(v)
            ? v.join(", ")
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v),
      ]),
    ]),
    "Review",
  );
  if (!ask(await p.confirm({ message: "Create this inbox?" }))) throw cancelled();

  const spin = p.spinner();
  spin.start("Creating inbox");
  let inbox: Inbox;
  try {
    inbox = await client.createInbox({ org: opts.org!, name, source_type: source.type, config });
  } catch (err) {
    spin.error("Could not create inbox");
    throw err;
  }
  spin.stop(`Created ${bold(inbox.name)} ${dim(inbox.id)}`);

  p.note(setupText(inbox), `Add this webhook in ${source.webhook_settings}`);
  if (source.secret.from === "sender" && !config.secret) {
    p.outro(`Then paste the secret ${source.label} shows with ${bold(`loopway inbox update ${inbox.id}`)}`);
  } else {
    p.outro(`Read messages with ${bold(`loopway messages list ${inbox.id}`)}`);
  }
  return inbox;
}

async function createScheduleInteractive(ctx: Context, client: LoopwayClient, opts: CreateOptions, name: string) {
  const config = (await editScheduleInteractive({
    schedule: { every: "day", hour: 9 },
    messages: [],
  })) as unknown as ScheduleConfig;
  try {
    applyScheduleFlags(config, {});
  } catch (err) {
    if (err instanceof ScheduleFlagError) {
      await ctx.metrics?.capture("inbox_create_rejected", { source: "schedule", reason: err.reason });
    }
    throw err;
  }
  const spin = p.spinner();
  spin.start("Creating inbox");
  let inbox: Inbox;
  try {
    inbox = await createScheduleInbox(ctx, client, opts.org!, name, config);
  } catch (err) {
    spin.error("Could not create inbox");
    throw err;
  }
  spin.stop(`Created ${bold(inbox.name)} ${dim(inbox.id)}`);
  p.note(scheduleText(inbox.config), "Schedule");
  p.outro(`Read messages with ${bold(`loopway messages list ${inbox.id}`)}`);
  return inbox;
}

async function sourceConfig(
  source: Source,
  opts: CreateOptions,
): Promise<{ events: string[]; secret?: string; schema?: Record<string, unknown> }> {
  const events = opts.events ?? (await pickEvents(source));

  // A sender-made secret is usually set afterwards with `inbox update`, so it's only taken from the flag.
  let secret = opts.secret;
  if (!secret && source.secret.from === "loopway") {
    const min = source.secret.min_length;
    const how = ask(
      await p.select({
        message: "Webhook secret",
        options: [
          { value: "generate", label: "Generate one for me", hint: "recommended" },
          { value: "custom", label: "I'll provide one" },
        ],
      }),
    );
    if (how === "custom") {
      secret = ask(
        await p.password({
          message: `Secret (at least ${min} characters)`,
          validate: (v) => ((v ?? "").length < min ? `Must be at least ${min} characters` : undefined),
        }),
      );
    }
  }

  return { events, ...(secret ? { secret } : {}), ...(opts.schema ? { schema: opts.schema } : {}) };
}

async function pickEvents(source: Source): Promise<string[]> {
  const which = ask(
    await p.select({
      message: `Which ${source.label} events should this inbox accept?`,
      options: [
        { value: "all", label: "Everything", hint: "whatever the webhook sends" },
        { value: "pick", label: "Let me choose" },
      ],
    }),
  );
  if (which === "all") return ["*"];
  const picked = ask(
    await p.multiselect({
      message: "Pick events (space to toggle, enter to confirm)",
      options: [...source.events.map((e) => ({ value: e })), { value: OTHER, label: "Other…" }],
      required: true,
    }),
  );
  const events = picked.filter((e) => e !== OTHER);
  if (picked.includes(OTHER)) {
    const extra = ask(
      await p.text({
        message: "Other event names (comma-separated)",
        validate: (v) => (!splitList(v ?? "").length && !events.length ? "Enter at least one event" : undefined),
      }),
    );
    events.push(...splitList(extra));
  }
  return events;
}

function flagConfig(opts: CreateOptions): Record<string, unknown> | undefined {
  const config = {
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.secret ? { secret: opts.secret } : {}),
    ...(opts.schema ? { schema: opts.schema } : {}),
  };
  return Object.keys(config).length ? config : undefined;
}

// ---------- update ----------

export interface UpdateOptions {
  name?: string;
  events?: string[];
  secret?: string;
  schema?: Record<string, unknown>;
  every?: string;
  hour?: number;
  message?: string[];
  messageFile?: string[];
  removeMessage?: string[];
  config?: ScheduleConfig;
  json?: boolean;
}

type ScheduleFlags = Pick<UpdateOptions, "every" | "hour" | "message" | "messageFile" | "removeMessage" | "config">;

const SCHEDULE_FLAGS = ["every", "hour", "message", "messageFile", "removeMessage", "config"] as const;
const SCHEDULE_FLAG_NAMES = "--every, --hour, --message, --message-file, --remove-message or --config";

/**
 * Changes the name, events, secret or schema. In a terminal with no flags, asks for the secret (a schedule inbox
 * is edited interactively instead). A schedule inbox's `--every`, `--hour`, `--message`, `--message-file`,
 * `--remove-message` and `--config` are applied to its current config, and the whole config is sent.
 */
export async function updateInbox(ctx: Context, ref: string, opts: UpdateOptions) {
  const client = await authedClient(ctx);
  const id = await resolveInbox(client, ref);
  const scheduleFlags = SCHEDULE_FLAGS.filter((f) => opts[f] !== undefined);
  const hasFlags = !!(opts.name || opts.events || opts.secret || opts.schema) || scheduleFlags.length > 0;

  const current = await client.getInbox(id);
  const isSchedule = current.source_type === "schedule";
  const reject = async (reason: string, message: string): Promise<never> => {
    await ctx.metrics?.capture("inbox_update_rejected", { source: current.source_type, reason });
    throw new UsageError(message);
  };

  let secret = opts.secret;
  let config: Record<string, unknown> | undefined;
  let how = "flags";
  if (isSchedule) {
    if (opts.events || opts.secret || opts.schema) {
      return reject("webhook_flag_on_schedule", "--events, --secret and --schema don't apply to a schedule inbox");
    }
    if (!hasFlags) {
      if (!ctx.interactive) return reject("no_flags", `Pass --name, ${SCHEDULE_FLAG_NAMES}`);
      how = "interactive";
      config = await editScheduleInteractive(current.config as unknown as ScheduleConfig);
    } else if (scheduleFlags.length) {
      try {
        config = applyScheduleFlags(current.config as unknown as ScheduleConfig, opts) as unknown as Record<
          string,
          unknown
        >;
      } catch (err) {
        if (err instanceof ScheduleFlagError) return reject(err.reason, err.message);
        throw err;
      }
    }
  } else {
    if (scheduleFlags.length) {
      return reject(
        "schedule_flag_on_other_source",
        `${SCHEDULE_FLAG_NAMES} only work on schedule inboxes; "${current.name}" is a ${current.source_type} inbox`,
      );
    }
    if (!hasFlags) {
      if (!ctx.interactive) throw new UsageError("Pass --name, --events, --secret or --schema");
      secret = ask(
        await p.password({ message: "Webhook secret", validate: (v) => (!v ? "Enter the secret" : undefined) }),
      );
    }
    config = flagConfig({ events: opts.events, secret, schema: opts.schema });
  }

  let inbox: Inbox;
  try {
    inbox = await client.updateInbox(id, { name: opts.name, config });
  } catch (err) {
    if (isSchedule && config) await ctx.metrics?.capture("schedule_update_failed", { reason: "server_rejected" });
    throw err;
  }
  if (isSchedule && config) await ctx.metrics?.capture("schedule_updated", { how: opts.config ? "file" : how });
  if (opts.json) return ctx.out(json(inbox));
  const body = inbox.source_type === "schedule" ? scheduleText(inbox.config) : setupText(inbox);
  ctx.out(`Updated inbox ${bold(inbox.name)} (${inbox.id})\n\n${body}`);
}

// ---------- schedule inboxes ----------

export interface ScheduleConfig {
  schedule: { every: "hour" } | { every: "day"; hour: number };
  messages: { type: string; message: string }[];
}

const TYPE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_MESSAGES = 20;
const MAX_TEXT = 10_000;

/** A bad schedule flag; `reason` is a low-cardinality label for metrics. */
class ScheduleFlagError extends UsageError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Collects a repeatable option into an array. */
export const collect = (value: string, previous: string[] = []) => [...previous, value];

export function parseHour(value: string): number {
  const hour = Number(value);
  if (!/^\d+$/.test(value) || hour > 23)
    throw new UsageError(`--hour must be a whole number from 0 to 23, got "${value}"`);
  return hour;
}

export function readScheduleConfig(path: string): ScheduleConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(
      `Could not read a schedule config from ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${path} must hold a JSON object like {"schedule": …, "messages": […]}`);
  }
  return value as ScheduleConfig;
}

/** Splits `<type>=<text>` at the first `=`. */
function splitMessage(flag: string, arg: string): [string, string] {
  const at = arg.indexOf("=");
  if (at < 1) throw new ScheduleFlagError("bad_message_flag", `${flag} takes <type>=<value>, got "${arg}"`);
  return [arg.slice(0, at), arg.slice(at + 1)];
}

/** The inbox's current config (or `--config`'s) with the flags applied; checks what the server checks. */
export function applyScheduleFlags(current: ScheduleConfig, opts: ScheduleFlags): ScheduleConfig {
  const base = opts.config ?? current;
  let schedule = base.schedule;
  const messages = new Map((base.messages ?? []).map((m) => [m.type, m.message]));

  if (opts.every !== undefined || opts.hour !== undefined) {
    const every = opts.every ?? schedule?.every;
    if (every === "hour") {
      if (opts.hour !== undefined) throw new ScheduleFlagError("bad_schedule", "--hour only applies with --every day");
      schedule = { every: "hour" };
    } else if (every === "day") {
      const hour = opts.hour ?? (schedule?.every === "day" ? schedule.hour : undefined);
      if (hour === undefined) throw new ScheduleFlagError("bad_schedule", "--every day needs --hour <0-23> (UTC)");
      schedule = { every: "day", hour };
    } else {
      throw new ScheduleFlagError("bad_schedule", `--every must be "hour" or "day", got "${every}"`);
    }
  }

  for (const type of opts.removeMessage ?? []) {
    if (!messages.delete(type)) {
      throw new ScheduleFlagError("unknown_type", `--remove-message: no message type "${type}" to remove`);
    }
  }
  for (const arg of opts.message ?? []) {
    const [type, text] = splitMessage("--message", arg);
    messages.set(type, text);
  }
  for (const arg of opts.messageFile ?? []) {
    const [type, path] = splitMessage("--message-file", arg);
    try {
      messages.set(type, readFileSync(path, "utf8").replace(/\n$/, ""));
    } catch (err) {
      throw new ScheduleFlagError(
        "unreadable_file",
        `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const [type, text] of messages) {
    if (!TYPE_RE.test(type)) {
      throw new ScheduleFlagError(
        "bad_type",
        `Message type "${type}" must be lowercase letters, digits, '.', '_' or '-' (up to 64 characters)`,
      );
    }
    if (!text) throw new ScheduleFlagError("empty_text", `Message "${type}" needs some text`);
    if (text.length > MAX_TEXT) {
      throw new ScheduleFlagError(
        "text_too_long",
        `Message "${type}" is ${text.length} characters; the limit is ${MAX_TEXT}`,
      );
    }
  }
  if (!messages.size) throw new ScheduleFlagError("no_messages", "A schedule inbox needs at least one message");
  if (messages.size > MAX_MESSAGES) {
    throw new ScheduleFlagError(
      "too_many_messages",
      `A schedule inbox takes up to ${MAX_MESSAGES} messages, this has ${messages.size}`,
    );
  }
  return { schedule, messages: [...messages].map(([type, message]) => ({ type, message })) };
}

const everyText = (s: ScheduleConfig["schedule"] | undefined) =>
  s?.every === "day" ? `daily at ${s.hour}:00 UTC` : "every hour";

/** What `inbox show` prints for a schedule inbox: the schedule, then each message type with its text. */
export function scheduleText(config: Partial<ScheduleConfig>): string {
  const lines = [fields([["schedule", everyText(config.schedule)]])];
  for (const m of config.messages ?? []) lines.push("", bold(m.type), m.message);
  return lines.join("\n");
}

/** Schedule first, then add / edit / remove messages until done; returns the whole new config. */
async function editScheduleInteractive(current: ScheduleConfig): Promise<Record<string, unknown>> {
  p.intro(bold(" Edit schedule "));
  let schedule = current.schedule;
  const messages = current.messages.map((m) => ({ ...m }));

  const every = ask(
    await p.select({
      message: "How often?",
      initialValue: schedule.every,
      options: [
        { value: "hour", label: "Every hour" },
        { value: "day", label: "Once a day (UTC)" },
      ],
    }),
  );
  if (every === "hour") schedule = { every: "hour" };
  else {
    const hour = ask(
      await p.text({
        message: "Which hour (0-23, UTC)?",
        initialValue: String(schedule.every === "day" ? schedule.hour : 9),
        validate: (v) => (/^\d+$/.test(v ?? "") && Number(v) <= 23 ? undefined : "A whole number from 0 to 23"),
      }),
    );
    schedule = { every: "day", hour: Number(hour) };
  }

  for (;;) {
    p.note(
      messages.map((m) => `${bold(m.type)}: ${m.message.split("\n")[0]!.slice(0, 60)}`).join("\n") || "(none)",
      "Messages",
    );
    const action = ask(
      await p.select({
        message: "What next?",
        options: [
          { value: "done", label: "Save" },
          { value: "add", label: "Add a message type" },
          ...(messages.length ? [{ value: "edit", label: "Edit a message" }] : []),
          ...(messages.length > 1 ? [{ value: "remove", label: "Remove a message type" }] : []),
        ],
      }),
    );
    if (action === "done") break;
    if (action === "add") {
      if (messages.length >= MAX_MESSAGES) {
        p.log.error(`A schedule inbox takes up to ${MAX_MESSAGES} messages`);
        continue;
      }
      const type = ask(
        await p.text({
          message: "Message type",
          placeholder: "e.g. standup",
          validate: (v) =>
            !TYPE_RE.test(v ?? "")
              ? "Lowercase letters, digits, '.', '_' or '-'"
              : messages.some((m) => m.type === v)
                ? "That type already exists"
                : undefined,
        }),
      );
      messages.push({ type, message: await askText(type, "") });
    } else {
      const type = ask(
        await p.select({ message: "Which one?", options: messages.map((m) => ({ value: m.type, label: m.type })) }),
      );
      const at = messages.findIndex((m) => m.type === type);
      if (action === "edit") messages[at]!.message = await askText(type, messages[at]!.message);
      else messages.splice(at, 1);
    }
  }
  return { schedule, messages };
}

async function askText(type: string, initialValue: string) {
  const multiline = initialValue.includes("\n");
  return ask(
    await p.text({
      message: multiline
        ? `New text for "${type}" (replaces the current multi-line text; use --message-file for multi-line)`
        : `Text for "${type}"`,
      initialValue: multiline ? "" : initialValue,
      validate: (v) =>
        !v?.trim() ? "Enter some text" : v.length > MAX_TEXT ? `${MAX_TEXT} characters max` : undefined,
    }),
  );
}

async function onlySource(client: LoopwayClient) {
  const sources = await client.sources();
  return sources.length === 1 ? sources[0]!.type : undefined;
}

/** Unwraps a prompt result, turning Ctrl-C / Esc into a CancelledError. */
function ask<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw cancelled();
  return value as Exclude<T, symbol>;
}

function cancelled() {
  p.cancel("No inbox created.");
  return new CancelledError();
}

// ---------- shared ----------

export function setupText(inbox: Inbox): string {
  const setup = inbox.setup ?? { webhook_url: inbox.webhook_url };
  return fields(
    Object.entries(setup).map(([k, v]): [string, string] => [
      humanize(k),
      Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : JSON.stringify(v),
    ]),
  );
}

/** Reads a `--schema` file: a JSON Schema object. */
export function readSchema(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(
      `Could not read a JSON schema from ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${path} must hold a JSON object`);
  }
  return value as Record<string, unknown>;
}

export const splitList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Commands take an inbox id or an exact inbox name. */
export async function resolveInbox(client: LoopwayClient, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const matches = (await client.listInboxes()).filter((i) => i.name === ref);
  if (matches.length === 1) return matches[0]!.id;
  if (!matches.length) throw new UsageError(`No inbox with id or name "${ref}". See \`loopway inbox list\`.`);
  throw new UsageError(
    `Several inboxes are named "${ref}"; use an id instead:\n${matches.map((i) => `  ${i.id}`).join("\n")}`,
  );
}
