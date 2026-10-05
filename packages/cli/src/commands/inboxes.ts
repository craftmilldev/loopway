import * as p from "@clack/prompts";
import type { Inbox, LoopwayClient } from "../client.js";
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
  json?: boolean;
}

const GITHUB_EVENTS = [
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
  "release",
  "workflow_run",
  "workflow_job",
  "check_run",
  "check_suite",
  "create",
  "delete",
  "deployment_status",
  "discussion",
  "star",
  "fork",
];
const OTHER = "__other__";

/**
 * Interactive: walks through name → source → source config → confirm, skipping any step whose
 * value came in as a flag. Non-interactive (no TTY): flags only, so it can be scripted.
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

  let source = opts.source;
  if (!source) {
    const spin = p.spinner();
    spin.start("Loading sources");
    const sources = await client.sources().catch((err: unknown) => {
      spin.error("Could not load sources");
      throw err;
    });
    spin.clear();
    source = ask(
      await p.select({
        message: "Where will events come from?",
        options: sources.map((s) => ({ value: s.type, label: s.type, hint: s.description })),
      }),
    );
  }

  const config = source === "github" ? await githubConfig(opts) : await genericConfig(opts);

  p.note(
    fields([
      ["name", name],
      ["source", source],
      ...Object.entries(config ?? {}).map(([k, v]): [string, string] => [
        k,
        k === "secret" ? "(provided)" : Array.isArray(v) ? v.join(", ") : String(v),
      ]),
    ]),
    "Review",
  );
  if (!ask(await p.confirm({ message: "Create this inbox?" }))) throw cancelled();

  const spin = p.spinner();
  spin.start("Creating inbox");
  let inbox: Inbox;
  try {
    inbox = await client.createInbox({ name, source_type: source, config });
  } catch (err) {
    spin.error("Could not create inbox");
    throw err;
  }
  spin.stop(`Created ${bold(inbox.name)} ${dim(inbox.id)}`);

  p.note(setupText(inbox), source === "github" ? "Add this webhook in GitHub → Settings → Webhooks" : "Setup");
  p.outro(`Read events with ${bold(`loopway events list ${inbox.id}`)}`);
  return inbox;
}

async function githubConfig(opts: CreateOptions) {
  let events = opts.events;
  if (!events) {
    const which = ask(
      await p.select({
        message: "Which GitHub events should this inbox accept?",
        options: [
          { value: "all", label: "Everything", hint: "whatever the webhook sends" },
          { value: "pick", label: "Let me choose" },
        ],
      }),
    );
    if (which === "all") events = ["*"];
    else {
      const picked = ask(
        await p.multiselect({
          message: "Pick events (space to toggle, enter to confirm)",
          options: [...GITHUB_EVENTS.map((e) => ({ value: e })), { value: OTHER, label: "Other…" }],
          required: true,
        }),
      );
      events = picked.filter((e) => e !== OTHER);
      if (picked.includes(OTHER)) {
        const extra = ask(
          await p.text({
            message: "Other event names (comma-separated)",
            placeholder: "e.g. merge_group, package",
            validate: (v) => (!splitList(v ?? "").length && !events!.length ? "Enter at least one event" : undefined),
          }),
        );
        events.push(...splitList(extra));
      }
    }
  }

  let secret = opts.secret;
  if (!secret) {
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
          message: "Secret (at least 16 characters)",
          validate: (v) => ((v ?? "").length < 16 ? "Must be at least 16 characters" : undefined),
        }),
      );
    }
  }

  return { events, ...(secret ? { secret } : {}) };
}

/** Sources without a dedicated flow take their config as JSON. */
async function genericConfig(opts: CreateOptions): Promise<Record<string, unknown> | undefined> {
  const fromFlags = flagConfig(opts);
  if (fromFlags) return fromFlags;
  const raw = ask(
    await p.text({
      message: "Source config as JSON (leave empty for defaults)",
      placeholder: "{}",
      validate: (v) => {
        if (!v?.trim()) return undefined;
        try {
          const parsed: unknown = JSON.parse(v);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "Must be a JSON object";
        } catch {
          return "Not valid JSON";
        }
      },
    }),
  );
  return raw?.trim() ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
}

function flagConfig(opts: CreateOptions): Record<string, unknown> | undefined {
  const config = { ...(opts.events ? { events: opts.events } : {}), ...(opts.secret ? { secret: opts.secret } : {}) };
  return Object.keys(config).length ? config : undefined;
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
      Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v),
    ]),
  );
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
