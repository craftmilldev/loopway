import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import type { Db } from "./db/index.js";
import { consoleSender, type SendEmail } from "./email.js";
import { isUuid, LOGIN_CODE_RE, normalizeLoginCode, uuidv7 } from "./ids.js";
import { sources } from "./sources/index.js";
import * as store from "./store.js";
import type { EventRow, Inbox, User } from "./store.js";
import { signSessionToken, verifyToken } from "./tokens.js";
import { createWeb } from "./ui.js";

export interface ApiOptions {
  getDb: () => Promise<Db>;
  /** Base for webhook URLs. Defaults to the request origin. */
  publicBaseUrl?: string;
  /** Delivers login codes. Defaults to printing them to the console. */
  sendEmail?: SendEmail;
  /** Signs session tokens (JWTs). */
  tokenSecret: string;
  /**
   * The craftmill loopway inbox that requests for new source types go to: its webhook URL and inbox
   * token. Without it, `POST /sources/requests` is a 404 and the web UI doesn't offer requests.
   */
  sourceRequests?: { url: string; token: string };
  /** Sends source requests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

type Env = { Variables: { db: Db; user: User } };

const DEFAULT_TTL = 300;
const MAX_TTL = 12 * 60 * 60;

export function createApi(opts: ApiOptions) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json({ error: { code: "invalid_request", message: "Invalid request", details: err.issues } }, 400);
    }
    if (err instanceof ApiError) {
      const details = err.details === undefined ? {} : { details: err.details };
      return c.json({ error: { code: err.code, message: err.message, ...details } }, err.status);
    }
    if (err instanceof HTTPException)
      return c.json({ error: { code: "http_error", message: err.message } }, err.status);
    console.error(err);
    return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

  app.use(async (c, next) => {
    c.set("db", await opts.getDb());
    await next();
  });

  // ---------- Public ----------

  app.route("/", createWeb());

  app.get("/api", (c) => c.json({ ok: true }));

  app.get("/health", async (c) => {
    await c.var.db.query("SELECT 1");
    return c.json({ ok: true });
  });

  app.post("/webhooks/:inboxId", async (c) => {
    const inboxId = c.req.param("inboxId");
    const inbox = isUuid(inboxId) ? await store.getInbox(c.var.db, inboxId) : undefined;
    if (!inbox) throw new ApiError(404, "not_found", "Inbox not found");
    const source = sources.get(inbox.source_type);
    if (!source) throw new ApiError(500, "internal", `Unknown source type ${inbox.source_type}`);

    const result = await source.receive(
      {
        headers: c.req.raw.headers,
        rawBody: await c.req.text(),
        receivedAt: new Date(),
        webhookUrl: webhookUrl(c, inbox.id),
      },
      inbox.config,
    );
    if (result.kind === "rejected") throw new ApiError(result.status, "rejected", result.message);
    if (result.kind === "ignored") return c.json({ ignored: true, reason: result.reason }, 200);
    const { id, duplicate } = await store.insertEvent(c.var.db, inbox.id, result.event);
    return c.json({ id, duplicate }, duplicate ? 200 : 202);
  });

  // Login: email a one-time code, then trade it for a session token (a JWT that lasts 30 days), creating
  // the user if the email is new (only after the code proves they own it).
  // The first step answers the same whether or not a code was already sent.
  // An address gets at most one code per TTL; asking again before it expires sends nothing.
  app.post("/auth/login", async (c) => {
    const { email } = z.object({ email: z.string().trim().email().max(320) }).parse(await jsonBody(c));
    const login = await store.createLoginCode(c.var.db, email);
    if (login.code) {
      await (opts.sendEmail ?? consoleSender)({
        to: login.email,
        subject: `Your loopway login code: ${login.code}`,
        text: `Your loopway login code is ${login.code}\n\nIt expires in ${store.LOGIN_CODE_TTL_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
      });
    }
    return c.json({ sent: true }, 202);
  });

  app.post("/auth/verify", async (c) => {
    const input = z
      .object({
        email: z.string().trim().email().max(320),
        code: z.string().transform(normalizeLoginCode).pipe(z.string().regex(LOGIN_CODE_RE)),
      })
      .parse(await jsonBody(c));
    const result = await store.redeemLoginCode(c.var.db, input.email, input.code);
    if (!result) throw new ApiError(401, "invalid_code", "That code is invalid or has expired");
    const { token, expiresAt } = signSessionToken(result.user.id, opts.tokenSecret);
    return c.json(
      { token, expires_at: expiresAt.toISOString(), user: serializeUser(result.user), created: result.created },
      201,
    );
  });

  // ---------- Authenticated ----------

  async function userForToken(db: Db, token: string) {
    const claims = verifyToken(token, opts.tokenSecret);
    return claims ? store.findUserById(db, claims.sub) : undefined;
  }

  const authed = new Hono<Env>();
  authed.use(async (c, next) => {
    const token = bearer(c);
    const user = token ? await userForToken(c.var.db, token) : undefined;
    if (!user) throw new ApiError(401, "unauthorized", "Missing, invalid or expired token");
    c.set("user", user);
    await next();
  });

  authed.get("/me", (c) => c.json(serializeUser(c.var.user)));

  authed.get("/sources", (c) => c.json({ data: sources.describe(), can_request: !!opts.sourceRequests }));

  // Asks for a source type loopway doesn't have yet, by posting a message to the craftmill inbox for them.
  authed.post("/sources/requests", async (c) => {
    const target = opts.sourceRequests;
    if (!target) throw new ApiError(404, "not_found", "This deployment doesn't take source requests");
    const { description } = z.object({ description: z.string().trim().min(1).max(500) }).parse(await jsonBody(c));
    const r = await (opts.fetch ?? fetch)(target.url, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "source.requested",
        id: uuidv7(),
        // Only the user's id: it's enough to look them up, and keeps their name and email out of the message.
        data: { description, user: { id: c.var.user.id } },
      }),
    }).catch((err: unknown) => {
      console.error("source request failed", err);
      return undefined;
    });
    if (!r?.ok) {
      if (r) console.error(`source request failed: ${r.status} ${await r.text()}`);
      throw new ApiError(502, "upstream", "Couldn't send the request. Try again later.");
    }
    return c.json({ requested: true }, 202);
  });

  // Inboxes

  authed.get("/inboxes", async (c) => {
    const rows = await store.listInboxes(c.var.db, c.var.user.id);
    return c.json({ data: rows.map((r) => serializeInbox(c, r)) });
  });

  authed.post("/inboxes", async (c) => {
    const input = z
      .object({ name: z.string().min(1).max(200), source_type: z.string(), config: z.unknown().optional() })
      .parse(await jsonBody(c));
    const source = sources.get(input.source_type);
    if (!source) {
      throw new ApiError(400, "invalid_request", `Unknown source_type. Available: ${sources.types().join(", ")}`);
    }
    const inbox = await store.createInbox(c.var.db, {
      userId: c.var.user.id,
      name: input.name,
      sourceType: source.type,
      config: source.parseConfig(input.config),
    });
    return c.json(serializeInbox(c, inbox), 201);
  });

  authed.get("/inboxes/:inboxId", async (c) => {
    const inbox = await ownedInbox(c);
    return c.json({ ...serializeInbox(c, inbox), stats: await store.inboxStats(c.var.db, inbox.id) });
  });

  authed.patch("/inboxes/:inboxId", async (c) => {
    const inbox = await ownedInbox(c);
    const input = z
      .object({ name: z.string().min(1).max(200).optional(), config: z.unknown().optional() })
      .parse(await jsonBody(c));
    const source = sources.get(inbox.source_type)!;
    const updated = await store.updateInbox(c.var.db, inbox.id, {
      name: input.name,
      config: input.config === undefined ? undefined : source.parseConfig(input.config, inbox.config),
    });
    return c.json(serializeInbox(c, updated));
  });

  authed.delete("/inboxes/:inboxId", async (c) => {
    const inbox = await ownedInbox(c);
    await store.deleteInbox(c.var.db, inbox.id);
    return c.body(null, 204);
  });

  // Events

  authed.get("/inboxes/:inboxId/events", async (c) => {
    const inbox = await ownedInbox(c);
    const q = z
      .object({
        type: z.string().min(1).optional(),
        cursor: z.string().refine(isUuid, "cursor must be an event id").optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        order: z.enum(["asc", "desc"]).default("asc"),
      })
      .parse(c.req.query());
    const { events, nextCursor } = await store.listEvents(c.var.db, inbox.id, {
      type: q.type,
      after: q.cursor,
      limit: q.limit,
      order: q.order,
    });
    return c.json({ data: events.map((e) => serializeEvent(e)), next_cursor: nextCursor });
  });

  const ttlBody = z.object({ ttl_seconds: z.number().int().min(1).max(MAX_TTL).default(DEFAULT_TTL) });

  authed.get("/inboxes/:inboxId/events/:eventId", async (c) => {
    const inbox = await ownedInbox(c);
    return c.json(serializeEvent(await existingEvent(c, inbox)));
  });

  // Bots

  const inboxIdsBody = z.array(z.string().refine(isUuid, "must be an inbox id")).min(1).max(100);

  authed.get("/bots", async (c) => {
    const rows = await store.listBots(c.var.db, c.var.user.id);
    return c.json({ data: rows.map(serializeBot) });
  });

  authed.post("/bots", async (c) => {
    const input = z
      .object({ name: z.string().min(1).max(200), kind: z.string().min(1).max(100), inbox_ids: inboxIdsBody })
      .parse(await jsonBody(c));
    const bot = await store.createBot(c.var.db, {
      userId: c.var.user.id,
      name: input.name,
      kind: input.kind,
      inboxIds: await ownedInboxIds(c, input.inbox_ids),
    });
    return c.json(serializeBot(bot), 201);
  });

  authed.get("/bots/:botId", async (c) => c.json(serializeBot(await ownedBot(c))));

  authed.patch("/bots/:botId", async (c) => {
    const bot = await ownedBot(c);
    const input = z
      .object({ name: z.string().min(1).max(200).optional(), inbox_ids: inboxIdsBody.optional() })
      .parse(await jsonBody(c));
    const updated = await store.updateBot(c.var.db, bot, {
      name: input.name,
      inboxIds: input.inbox_ids && (await ownedInboxIds(c, input.inbox_ids)),
    });
    return c.json(serializeBot(updated));
  });

  authed.delete("/bots/:botId", async (c) => {
    const bot = await ownedBot(c);
    await store.deleteBot(c.var.db, bot.id);
    return c.body(null, 204);
  });

  authed.post("/bots/:botId/lease", async (c) => {
    const bot = await ownedBot(c);
    const input = ttlBody.extend({ lease_token: z.string().optional() }).parse(await jsonBody(c));
    const row = await store.leaseBot(c.var.db, bot.id, input.ttl_seconds, input.lease_token ?? null);
    if (!row) {
      const until = iso(bot.locked_until);
      throw new ApiError(409, "leased", `Bot is leased until ${until} by another runner`, { expires_at: until });
    }
    return c.json({ lease: { token: row.lock_token, expires_at: iso(row.locked_until) } });
  });

  authed.post("/bots/:botId/release", async (c) => {
    const bot = await ownedBot(c);
    const { lease_token, force } = z
      .object({ lease_token: z.string().min(1).optional(), force: z.boolean().optional() })
      .parse(await jsonBody(c));
    if (force) await store.forceReleaseBot(c.var.db, bot.id);
    else if (!lease_token)
      throw new ApiError(400, "invalid_request", "Pass lease_token, or force: true to drop whoever's lease");
    else if (!(await store.releaseBot(c.var.db, bot.id, lease_token))) throw leaseMismatch(bot);
    return c.body(null, 204);
  });

  authed.post("/bots/:botId/cursor", async (c) => {
    const bot = await ownedBot(c);
    const { seq, lease_token } = z
      .object({ seq: z.number().int().min(0), lease_token: z.string().min(1) })
      .parse(await jsonBody(c));
    const row = await store.advanceCursor(c.var.db, bot.id, seq, lease_token);
    if (!row) throw leaseMismatch(bot);
    return c.json(serializeBot(row));
  });

  authed.get("/bots/:botId/messages", async (c) => {
    const bot = await ownedBot(c);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(c.req.query());
    const rows = await store.botMessages(c.var.db, bot.id, q.limit);
    return c.json({ data: rows.map((e) => serializeEvent(e)) });
  });

  app.route("/", authed);
  return app;

  // ---------- helpers (closures over opts) ----------

  async function ownedBot(c: Context<Env>): Promise<store.Bot> {
    const id = c.req.param("botId") ?? "";
    const bot = isUuid(id) ? await store.getBot(c.var.db, id, c.var.user.id) : undefined;
    if (!bot) throw new ApiError(404, "not_found", "Bot not found");
    return bot;
  }

  /** The ids, deduped, once they're all the user's inboxes. */
  async function ownedInboxIds(c: Context<Env>, ids: string[]): Promise<string[]> {
    const mine = new Set((await store.listInboxes(c.var.db, c.var.user.id)).map((i) => i.id));
    const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
    const unknown = wanted.filter((id) => !mine.has(id));
    if (unknown.length) throw new ApiError(400, "invalid_request", `Unknown inbox id(s): ${unknown.join(", ")}`);
    return wanted;
  }

  async function ownedInbox(c: Context<Env>): Promise<Inbox> {
    const id = c.req.param("inboxId") ?? "";
    const inbox = isUuid(id) ? await store.getInbox(c.var.db, id, c.var.user.id) : undefined;
    if (!inbox) throw new ApiError(404, "not_found", "Inbox not found");
    return inbox;
  }

  function webhookUrl(c: Context<Env>, inboxId: string) {
    const base = (opts.publicBaseUrl || new URL(c.req.url).origin).replace(/\/+$/, "");
    return `${base}/webhooks/${inboxId}`;
  }

  function serializeInbox(c: Context<Env>, inbox: Inbox) {
    const source = sources.get(inbox.source_type);
    const url = webhookUrl(c, inbox.id);
    return {
      id: inbox.id,
      name: inbox.name,
      source_type: inbox.source_type,
      config: source ? source.publicConfig(inbox.config) : inbox.config,
      webhook_url: url,
      setup: source?.setup?.(inbox.config, url),
      created_at: iso(inbox.created_at),
    };
  }
}

// ---------- module helpers ----------

export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 415 | 422 | 500 | 502,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim();
}

async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be JSON");
  }
}

async function existingEvent(c: Context<Env>, inbox: Inbox): Promise<EventRow> {
  const id = c.req.param("eventId") ?? "";
  const row = isUuid(id) ? await store.getEvent(c.var.db, inbox.id, id) : undefined;
  if (!row) throw new ApiError(404, "not_found", "Event not found");
  return row;
}

function leaseMismatch(b: store.Bot): ApiError {
  if (!b.locked_until || new Date(b.locked_until) <= new Date())
    return new ApiError(409, "not_leased", "Bot is not leased");
  return new ApiError(409, "lease_mismatch", "lease_token is not the bot's live lease");
}

function serializeUser(u: User) {
  return { id: u.id, name: u.name, email: u.email, created_at: iso(u.created_at) };
}

function serializeEvent(e: EventRow) {
  return {
    id: e.id,
    inbox_id: e.inbox_id,
    seq: Number(e.seq),
    received_at: iso(e.received_at),
    event: e.cloudevent,
  };
}

function serializeBot(b: store.Bot) {
  return {
    id: b.id,
    name: b.name,
    kind: b.kind,
    inbox_ids: b.inbox_ids,
    cursor: Number(b.cursor),
    created_at: iso(b.created_at),
  };
}

function iso(d: Date | string | null): string | null {
  if (d == null) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}
