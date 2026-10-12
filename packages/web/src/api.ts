import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import { eeRoutes, type EeOptions } from "../ee/routes.js";
import type { Db } from "./db/index.js";
import { consoleSender, type SendEmail } from "./email.js";
import { ApiError, jsonBody, type Env } from "./http.js";
import { isUuid, LOGIN_CODE_RE, normalizeLoginCode } from "./ids.js";
import { ANONYMOUS, noopMetrics, type Metrics } from "./metrics.js";
import { BOT_MODELS } from "./models.js";
import { createPosthogProxy } from "./posthog-proxy.js";
import { sources } from "./sources/index.js";
import * as store from "./store.js";
import type { MessageRow, Inbox, User } from "./store.js";
import { signSessionToken, verifyToken } from "./tokens.js";
import { createWeb } from "./ui.js";

export interface ApiOptions extends EeOptions {
  getDb: () => Promise<Db>;
  /** Base for webhook URLs. Defaults to the request origin. */
  publicBaseUrl?: string;
  /** Delivers login codes. Defaults to printing them to the console. */
  sendEmail?: SendEmail;
  /** PostHog cloud region the /ingest proxy forwards to. Defaults to "us". */
  posthogRegion?: "us" | "eu";
  /** PostHog project key the browser UI reports to through /ingest. Unset, the UI sends no metrics. */
  posthogKey?: string;
  /** PostHog's UI host (the toolbar needs it behind a proxy). Defaults to the region's, https://us.posthog.com. */
  posthogUiHost?: string;
  /** Signs session tokens (JWTs). */
  tokenSecret: string;
  /** Product metrics. Defaults to recording nothing. */
  metrics?: Metrics;
}

const DEFAULT_TTL = 300;
const MAX_TTL = 12 * 60 * 60;

export function createApi(opts: ApiOptions) {
  const app = new Hono<Env>();
  const metrics = opts.metrics ?? noopMetrics;

  // Every error response is counted by its code, so the metrics show where requests stop.
  const failed = (c: Context<Env>, code: string, status: number) =>
    metrics.capture("api_error", c.get("user")?.id ?? ANONYMOUS, {
      code,
      status,
      method: c.req.method,
      route: c.req.routePath,
    });

  app.onError(async (err, c) => {
    if (err instanceof ZodError) {
      await failed(c, "invalid_request", 400);
      return c.json({ error: { code: "invalid_request", message: "Invalid request", details: err.issues } }, 400);
    }
    if (err instanceof ApiError) {
      await failed(c, err.code, err.status);
      const details = err.details === undefined ? {} : { details: err.details };
      return c.json({ error: { code: err.code, message: err.message, ...details } }, err.status);
    }
    if (err instanceof HTTPException) {
      await failed(c, "http_error", err.status);
      return c.json({ error: { code: "http_error", message: err.message } }, err.status);
    }
    console.error(err);
    await failed(c, "internal", 500);
    return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

  // Registered before the db middleware: forwarding analytics needs no database.
  app.route("/", createPosthogProxy({ region: opts.posthogRegion }));

  app.use(async (c, next) => {
    c.set("db", await opts.getDb());
    await next();
  });

  // ---------- Public ----------

  app.route(
    "/",
    createWeb({
      posthogKey: opts.posthogKey,
      posthogUiHost:
        opts.posthogUiHost ?? (opts.posthogRegion === "eu" ? "https://eu.posthog.com" : "https://us.posthog.com"),
    }),
  );

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
    const received = (outcome: string, extra?: Record<string, unknown>) =>
      metrics.capture("webhook_received", inbox.user_id, { source_type: inbox.source_type, outcome, ...extra });

    const result = await source.receive(
      {
        headers: c.req.raw.headers,
        rawBody: await c.req.text(),
        receivedAt: new Date(),
        webhookUrl: webhookUrl(c, inbox.id),
      },
      inbox.config,
    );
    if (result.kind === "rejected") {
      await received("rejected", { status: result.status });
      throw new ApiError(result.status, "rejected", result.message);
    }
    if (result.kind === "ignored") {
      await received("ignored", { reason: result.reason });
      return c.json({ ignored: true, reason: result.reason }, 200);
    }
    const { id, duplicate } = await store.insertMessage(c.var.db, inbox.id, result.event);
    await received(duplicate ? "duplicate" : "accepted");
    return c.json({ id, duplicate }, duplicate ? 200 : 202);
  });

  // Login: email a one-time code, then trade it for a session token (a JWT that lasts 30 days), creating
  // the user if the email is new (only after the code proves they own it).
  // The first step answers the same whether or not a code was already sent.
  // An address gets at most one code per TTL; asking again before it expires sends nothing.
  app.post("/auth/login", async (c) => {
    const { email } = z.object({ email: z.string().trim().email().max(320) }).parse(await jsonBody(c));
    const login = await store.createLoginCode(c.var.db, email);
    await metrics.capture("login_requested", ANONYMOUS, { sent: !!login.code });
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
    await metrics.capture(result.created ? "signed_up" : "logged_in", result.user.id);
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

  // Routes under ee/ are the commercially licensed ones.
  authed.route("/", eeRoutes(opts));

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
    await metrics.capture("inbox_created", c.var.user.id, { source_type: inbox.source_type });
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

  // Messages

  authed.get("/inboxes/:inboxId/messages", async (c) => {
    const inbox = await ownedInbox(c);
    const q = z
      .object({
        type: z.string().min(1).optional(),
        cursor: z.string().refine(isUuid, "cursor must be a message id").optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        order: z.enum(["asc", "desc"]).default("asc"),
      })
      .parse(c.req.query());
    const { messages, nextCursor } = await store.listMessages(c.var.db, inbox.id, {
      type: q.type,
      after: q.cursor,
      limit: q.limit,
      order: q.order,
    });
    return c.json({ data: messages.map((e) => serializeMessage(e)), next_cursor: nextCursor });
  });

  const runnerId = z
    .string()
    .refine(isUuid, "must be a runner id")
    .transform((s) => s.toLowerCase());
  const ttlBody = z.object({ ttl_seconds: z.number().int().min(1).max(MAX_TTL).default(DEFAULT_TTL) });

  authed.get("/inboxes/:inboxId/messages/:messageId", async (c) => {
    const inbox = await ownedInbox(c);
    return c.json(serializeMessage(await existingMessage(c, inbox)));
  });

  // Runners

  authed.get("/runners", async (c) => {
    const rows = await store.listRunners(c.var.db, c.var.user.id);
    return c.json({ data: rows.map(serializeRunner) });
  });

  // The CLI makes the id and calls this on startup; it is safe to repeat.
  authed.post("/runners", async (c) => {
    const input = z.object({ id: runnerId, name: z.string().min(1).max(200) }).parse(await jsonBody(c));
    const runner = await store.upsertRunner(c.var.db, c.var.user.id, input.id, input.name);
    if (!runner) throw new ApiError(409, "runner_exists", "That runner id belongs to another user");
    return c.json(serializeRunner(runner));
  });

  // One process at a time uses a runner id: it leases the runner while it runs, and thread writes need the lease.
  authed.post("/runners/:runnerId/lease", async (c) => {
    const runner = await routeRunner(c);
    const input = ttlBody.extend({ lease_token: z.string().optional() }).parse(await jsonBody(c));
    const row = await store.leaseRunner(
      c.var.db,
      c.var.user.id,
      runner.id,
      input.ttl_seconds,
      input.lease_token ?? null,
    );
    if (!row) {
      const until = iso(runner.locked_until);
      throw new ApiError(409, "runner_leased", `Runner is leased until ${until} by another process`, {
        expires_at: until,
      });
    }
    return c.json({ lease: { token: row.lock_token, expires_at: iso(row.locked_until) } });
  });

  authed.post("/runners/:runnerId/release", async (c) => {
    const runner = await routeRunner(c);
    const { lease_token, force } = z
      .object({ lease_token: z.string().min(1).optional(), force: z.boolean().optional() })
      .parse(await jsonBody(c));
    if (!force && !lease_token)
      throw new ApiError(400, "invalid_request", "Pass lease_token, or force: true to drop whoever's lease");
    if (!(await store.releaseRunner(c.var.db, c.var.user.id, runner.id, force ? null : lease_token!)))
      throw new ApiError(409, "runner_lease_mismatch", "lease_token is not the runner's live lease");
    return c.body(null, 204);
  });

  // Bots

  const inboxIdsBody = z.array(z.string().refine(isUuid, "must be an inbox id")).min(1).max(100);

  const modelBody = z.enum(BOT_MODELS);

  const promptBody = z.string().min(1).max(100_000);

  const expression = z.string().min(1).max(2_000);
  const rulesBody = z
    .array(
      z.strictObject({
        types: z.array(z.string().min(1).max(200)).min(1).max(50),
        subject: expression.optional(),
        related: expression.optional(),
        action: expression.optional(),
      }),
    )
    .max(100);

  authed.get("/bots", async (c) => {
    const rows = await store.listBots(c.var.db, c.var.user.id);
    return c.json({ data: rows.map(serializeBot) });
  });

  authed.post("/bots", async (c) => {
    const input = z
      .object({
        name: z.string().min(1).max(200),
        kind: z.string().min(1).max(100),
        model: modelBody,
        inbox_ids: inboxIdsBody,
        prompt: promptBody.optional(),
        rules: rulesBody.optional(),
      })
      .parse(await jsonBody(c));
    const bot = await store.createBot(c.var.db, {
      userId: c.var.user.id,
      name: input.name,
      kind: input.kind,
      model: input.model,
      inboxIds: await ownedInboxIds(c, input.inbox_ids),
      prompt: input.prompt,
      rules: input.rules,
    });
    return c.json(serializeBot(bot), 201);
  });

  authed.get("/bots/:botId", async (c) => c.json(serializeBot(await ownedBot(c))));

  authed.patch("/bots/:botId", async (c) => {
    const bot = await ownedBot(c);
    const input = z
      .object({
        name: z.string().min(1).max(200).optional(),
        model: modelBody.optional(),
        inbox_ids: inboxIdsBody.optional(),
      })
      .parse(await jsonBody(c));
    const updated = await store.updateBot(c.var.db, bot, {
      name: input.name,
      model: input.model,
      inboxIds: input.inbox_ids && (await ownedInboxIds(c, input.inbox_ids)),
    });
    return c.json(serializeBot(updated));
  });

  authed.post("/bots/:botId/versions", async (c) => {
    const bot = await ownedBot(c);
    const input = z.object({ prompt: promptBody, rules: rulesBody.optional() }).parse(await jsonBody(c));
    return c.json(await store.addBotVersion(c.var.db, bot.id, input.prompt, input.rules), 201);
  });

  authed.delete("/bots/:botId", async (c) => {
    const bot = await ownedBot(c);
    await store.deleteBot(c.var.db, bot.id);
    return c.body(null, 204);
  });

  authed.post("/bots/:botId/lease", async (c) => {
    const bot = await ownedBot(c);
    const input = ttlBody
      .extend({ lease_token: z.string().optional(), runner_id: runnerId.optional() })
      .parse(await jsonBody(c));
    if (input.runner_id) await ownedRunner(c, input.runner_id);
    const row = await store.leaseBot(c.var.db, bot.id, input.ttl_seconds, input.lease_token ?? null, input.runner_id);
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
    return c.json({ data: rows.map((e) => serializeMessage(e)) });
  });

  // Threads. A thread belongs to the runner that claimed it; writing it needs that runner's live lease.

  const leaseToken = z.string().min(1);
  const uuid = z
    .string()
    .refine(isUuid, "must be a uuid")
    .transform((s) => s.toLowerCase());
  const threadSubjects = z.array(z.string().min(1).max(500)).max(100);

  authed.get("/bots/:botId/threads", async (c) => {
    const bot = await ownedBot(c);
    const q = z.object({ status: z.enum(["active", "ended", "all"]).default("active") }).parse(c.req.query());
    const rows = await store.listThreads(c.var.db, bot.id, q.status);
    return c.json({ data: rows.map((t) => serializeThread(t)) });
  });

  authed.get("/bots/:botId/threads/:threadId", async (c) => {
    const bot = await ownedBot(c);
    return c.json(serializeThread(await existingThread(c, bot)));
  });

  authed.post("/bots/:botId/threads/:threadId/claim", async (c) => {
    const bot = await ownedBot(c);
    const thread = await existingThread(c, bot);
    const { lease_token } = z.object({ lease_token: leaseToken }).parse(await jsonBody(c));
    const runner = await liveRunner(c, lease_token);
    if (thread.runner_id && thread.runner_id !== runner.id) throw threadOwned(thread);
    const claimed = await store.claimThread(c.var.db, c.var.user.id, bot.id, thread.id, lease_token);
    if (!claimed) throw runnerNotLeased();
    return c.json(serializeThread(claimed));
  });

  // The manual move, for when the thread's runner is gone: the thread has no owner until a runner claims it.
  authed.post("/bots/:botId/threads/:threadId/release", async (c) => {
    const bot = await ownedBot(c);
    const thread = await existingThread(c, bot);
    await store.releaseThread(c.var.db, bot.id, thread.id);
    return c.json(serializeThread((await store.getThread(c.var.db, bot.id, thread.id))!));
  });

  authed.post("/bots/:botId/assign", async (c) => {
    const bot = await ownedBot(c);
    const input = z
      .object({
        lease_token: leaseToken,
        cursor: z.number().int().min(0),
        assignments: z
          .array(
            z.object({
              message_id: uuid,
              thread_id: uuid,
              add_subjects: threadSubjects.optional(),
              subject: z.string().min(1).max(500).optional(),
            }),
          )
          .max(100),
      })
      .parse(await jsonBody(c));
    requireLease(bot, input.lease_token);

    const assignments = input.assignments as store.Assignment[];
    const threadIds = [...new Set(assignments.map((a) => a.thread_id))];
    const bots = await store.threadBots(c.var.db, threadIds);
    const foreign = threadIds.filter((id) => bots.has(id) && bots.get(id) !== bot.id);
    if (foreign.length)
      throw new ApiError(409, "thread_exists", `Thread id(s) belong to another bot: ${foreign.join(", ")}`);

    await checkSubjects(
      c,
      bot,
      assignments.flatMap((a) => (a.add_subjects ?? []).map((subject) => ({ subject, threadId: a.thread_id }))),
    );

    const messageIds = [...new Set(assignments.map((a) => a.message_id))];
    const known = await store.botMessageIds(c.var.db, bot.id, messageIds);
    const unknown = messageIds.filter((id) => !known.has(id));
    if (unknown.length)
      throw new ApiError(400, "invalid_request", `Not messages in the bot's inboxes: ${unknown.join(", ")}`);

    const done = await store.assignMessages(c.var.db, bot.id, input.lease_token, input.cursor, assignments);
    if (!done) throw leaseMismatch(bot);
    return c.json({ assigned: done.assigned });
  });

  authed.patch("/bots/:botId/threads/:threadId", async (c) => {
    const bot = await ownedBot(c);
    const thread = await existingThread(c, bot);
    const input = z
      .object({
        lease_token: leaseToken,
        status: z.enum(["active", "ended"]).optional(),
        started: z.boolean().optional(),
        interrupted: z.boolean().optional(),
        limited: z.boolean().optional(),
        add_subjects: threadSubjects.optional(),
      })
      .parse(await jsonBody(c));
    await requireOwner(c, thread, input.lease_token);
    await checkSubjects(
      c,
      bot,
      (input.add_subjects ?? []).map((subject) => ({ subject, threadId: thread.id })),
    );

    const { lease_token, add_subjects, ...fields } = input;
    if (!(await store.patchThread(c.var.db, bot.id, lease_token, thread.id, { ...fields, addSubjects: add_subjects })))
      throw runnerNotLeased();
    return c.json(serializeThread((await store.getThread(c.var.db, bot.id, thread.id))!));
  });

  // The manual repair for a subject that landed on the wrong thread. Needs no lease, like release.
  authed.post("/bots/:botId/threads/:threadId/move-subject", async (c) => {
    const bot = await ownedBot(c);
    const to = await existingThread(c, bot);
    const { subject } = z.object({ subject: z.string().min(1).max(500) }).parse(await jsonBody(c));
    const from = (await store.subjectHolders(c.var.db, bot.id, [subject])).get(subject);
    if (!from) throw new ApiError(404, "not_found", `Subject ${subject} isn't on any of the bot's threads`);
    if (from === to.id)
      throw new ApiError(409, "subject_on_thread", `Subject ${subject} is already on thread ${to.id}`);
    if (!(await store.moveSubject(c.var.db, bot.id, subject, to.id)))
      throw new ApiError(404, "not_found", `Subject ${subject} isn't on any of the bot's threads`);
    return c.json(serializeThread((await store.getThread(c.var.db, bot.id, to.id))!));
  });

  authed.post("/bots/:botId/threads/:threadId/deliver", async (c) => {
    const bot = await ownedBot(c);
    const thread = await existingThread(c, bot);
    const { lease_token } = z.object({ lease_token: leaseToken }).parse(await jsonBody(c));
    await requireOwner(c, thread, lease_token);
    const messages = await store.deliverThread(c.var.db, bot.id, lease_token, thread.id);
    if (!messages) throw runnerNotLeased();
    return c.json({ data: messages });
  });

  authed.post("/bots/:botId/threads/:threadId/finish", async (c) => {
    const bot = await ownedBot(c);
    const thread = await existingThread(c, bot);
    const { lease_token, requeue } = z
      .object({ lease_token: leaseToken, requeue: z.boolean().optional() })
      .parse(await jsonBody(c));
    await requireOwner(c, thread, lease_token);
    const done = await store.finishThread(c.var.db, bot.id, lease_token, thread.id, requeue ?? false);
    if (!done) throw runnerNotLeased();
    return c.json({ moved: done.moved });
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

  /** The runner must be the user's; using it counts as seeing it. */
  async function ownedRunner(c: Context<Env>, id: string): Promise<store.Runner> {
    const runner = await store.getRunner(c.var.db, c.var.user.id, id);
    if (!runner) throw new ApiError(404, "not_found", "Runner not found; register it with POST /runners");
    await store.touchRunner(c.var.db, runner.id);
    return runner;
  }

  /** The runner in the path, if it's the user's. */
  async function routeRunner(c: Context<Env>): Promise<store.Runner> {
    const id = c.req.param("runnerId") ?? "";
    const runner = isUuid(id) ? await store.getRunner(c.var.db, c.var.user.id, id.toLowerCase()) : undefined;
    if (!runner) throw new ApiError(404, "not_found", "Runner not found; register it with POST /runners");
    return runner;
  }

  /** The runner holding the live lease `token`: 409 if there is none. */
  async function liveRunner(c: Context<Env>, token: string): Promise<store.Runner> {
    const runner = await store.runnerByToken(c.var.db, c.var.user.id, token);
    if (!runner) throw runnerNotLeased();
    return runner;
  }

  /** Fails fast, with the 409s the write's own check would give, unless `token` is the live lease of the thread's owner. */
  async function requireOwner(c: Context<Env>, thread: store.Thread, token: string) {
    const runner = await liveRunner(c, token);
    if (!thread.runner_id)
      throw new ApiError(409, "thread_unclaimed", "Claim the thread with POST .../claim before writing it");
    if (thread.runner_id !== runner.id) throw threadOwned(thread);
  }

  async function existingThread(c: Context<Env>, bot: store.Bot, threadId?: string): Promise<store.Thread> {
    const id = threadId ?? c.req.param("threadId") ?? "";
    const thread = isUuid(id) ? await store.getThread(c.var.db, bot.id, id.toLowerCase()) : undefined;
    if (!thread) throw new ApiError(404, "not_found", "Thread not found");
    return thread;
  }

  /** 409 if a subject is already on another of the bot's threads, or the batch wants it on two. */
  async function checkSubjects(c: Context<Env>, bot: store.Bot, wanted: { subject: string; threadId: string }[]) {
    if (!wanted.length) return;
    const holders = await store.subjectHolders(c.var.db, bot.id, [...new Set(wanted.map((w) => w.subject))]);
    const claimed = new Map(holders);
    for (const { subject, threadId } of wanted) {
      const holder = claimed.get(subject);
      if (holder && holder !== threadId)
        throw new ApiError(409, "subject_taken", `Subject ${subject} already belongs to thread ${holder}`, {
          subject,
          thread_id: holder,
        });
      claimed.set(subject, threadId);
    }
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

function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim();
}

async function existingMessage(c: Context<Env>, inbox: Inbox): Promise<MessageRow> {
  const id = c.req.param("messageId") ?? "";
  const row = isUuid(id) ? await store.getMessage(c.var.db, inbox.id, id) : undefined;
  if (!row) throw new ApiError(404, "not_found", "Message not found");
  return row;
}

function leaseMismatch(b: store.Bot): ApiError {
  if (!b.locked_until || new Date(b.locked_until) <= new Date())
    return new ApiError(409, "not_leased", "Bot is not leased");
  return new ApiError(409, "lease_mismatch", "lease_token is not the bot's live lease");
}

function runnerNotLeased(): ApiError {
  return new ApiError(409, "runner_not_leased", "lease_token is not a live runner lease");
}

function threadOwned(t: store.Thread): ApiError {
  return new ApiError(409, "thread_owned", "The thread belongs to another runner", { runner_id: t.runner_id });
}

function serializeRunner(r: store.Runner) {
  return {
    id: r.id,
    name: r.name,
    created_at: iso(r.created_at),
    last_seen_at: iso(r.last_seen_at),
    leased_until: r.locked_until && new Date(r.locked_until) > new Date() ? iso(r.locked_until) : null,
    bots: r.bots,
    threads: r.threads,
  };
}

/** Fails fast with the same 409s the write's own lease check would give. */
function requireLease(b: store.Bot, token: string) {
  if (!b.lock_token || b.lock_token !== token || !b.locked_until || new Date(b.locked_until) <= new Date())
    throw leaseMismatch(b);
}

function serializeThread(t: store.Thread) {
  return {
    id: t.id,
    bot_id: t.bot_id,
    status: t.status,
    started: t.started,
    interrupted: t.interrupted,
    limited: t.limited,
    runner_id: t.runner_id,
    subjects: t.subjects,
    waiting: t.waiting,
    inflight: t.inflight,
    delivered: t.delivered,
    ...(t.delivered_ids ? { delivered_ids: t.delivered_ids } : {}),
    ...(t.delivered_messages ? { delivered_messages: t.delivered_messages } : {}),
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
  };
}

function serializeUser(u: User) {
  return { id: u.id, name: u.name, email: u.email, created_at: iso(u.created_at) };
}

function serializeMessage(e: MessageRow) {
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
    model: b.model,
    inbox_ids: b.inbox_ids,
    prompt_version: b.prompt_version,
    cursor: Number(b.cursor),
    runner_id: b.runner_id,
    leased_until: b.locked_until && new Date(b.locked_until) > new Date() ? iso(b.locked_until) : null,
    created_at: iso(b.created_at),
  };
}

function iso(d: Date | string | null): string | null {
  if (d == null) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}
