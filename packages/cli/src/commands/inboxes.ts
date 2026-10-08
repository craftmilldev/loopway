import * as p from "@clack/prompts";
import { readFileSync } from "node:fs";
import type { Inbox, LoopwayClient, Source } from "../client.js";
import { authedClient, CancelledError, UsageError, type Context } from "../context.js";
import { ago, bold, dim, fields, humanize, json, table } from "../format.js";

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
        ["events", `${stats.pending} pending · ${stats.locked} locked · ${stats.processed} processed`],
      ]),
      "",
      setupText(inbox),
    ].join("\n"),
  );
}

// ---------- create ----------

export interface CreateOptions {
  name?: string;
  source?: string;
  events?: string[];
  secret?: string;
  schema?: Record<string, unknown>;
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
  const inbox = ctx.interactive ? await createInteractive(client, opts) : await createFromFlags(client, opts);
  if (opts.json) return ctx.out(json(inbox));
  if (!ctx.interactive) ctx.out(`Created inbox ${bold(inbox.name)} (${inbox.id})\n\n${setupText(inbox)}`);
}

async function createFromFlags(client: LoopwayClient, opts: CreateOptions) {
  if (!opts.name) throw new UsageError("--name is required when not running in a terminal");
  const source = opts.source ?? (await onlySource(client));
  if (!source) throw new UsageError("--source is required when not running in a terminal");
  return client.createInbox({ name: opts.name, source_type: source, config: flagConfig(opts) });
}

async function createInteractive(client: LoopwayClient, opts: CreateOptions): Promise<Inbox> {
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
        message: "Where will events come from?",
        options: sources.map((s) => ({ value: s.type, label: s.label, hint: s.description })),
      }),
    );
  const source = sources.find((s) => s.type === type);
  if (!source) throw new UsageError(`Unknown source "${type}". Available: ${sources.map((s) => s.type).join(", ")}`);

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
    inbox = await client.createInbox({ name, source_type: source.type, config });
  } catch (err) {
    spin.error("Could not create inbox");
    throw err;
  }
  spin.stop(`Created ${bold(inbox.name)} ${dim(inbox.id)}`);

  p.note(setupText(inbox), `Add this webhook in ${source.webhook_settings}`);
  if (source.secret.from === "sender" && !config.secret) {
    p.outro(`Then paste the secret ${source.label} shows with ${bold(`loopway inbox update ${inbox.id}`)}`);
  } else {
    p.outro(`Read events with ${bold(`loopway events list ${inbox.id}`)}`);
  }
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
  json?: boolean;
}

/** Changes the name, events, secret or schema. In a terminal with no flags, asks for the secret. */
export async function updateInbox(ctx: Context, ref: string, opts: UpdateOptions) {
  const client = await authedClient(ctx);
  const id = await resolveInbox(client, ref);
  let secret = opts.secret;
  if (!opts.name && !opts.events && !secret && !opts.schema) {
    if (!ctx.interactive) throw new UsageError("Pass --name, --events, --secret or --schema");
    secret = ask(
      await p.password({ message: "Webhook secret", validate: (v) => (!v ? "Enter the secret" : undefined) }),
    );
  }
  const config = flagConfig({ events: opts.events, secret, schema: opts.schema });
  const inbox = await client.updateInbox(id, { name: opts.name, config });
  if (opts.json) return ctx.out(json(inbox));
  ctx.out(`Updated inbox ${bold(inbox.name)} (${inbox.id})\n\n${setupText(inbox)}`);
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
