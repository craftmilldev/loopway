import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import { cliVersion, olderThan } from "./cli-version.js";
import type { Db } from "./db/index.js";
import { consoleSender, type SendEmail } from "./email.js";
import { ApiError, jsonBody, type Env } from "./http.js";
import { makeCloudEvent, type CloudEvent } from "./cloudevents.js";
import { handleMcp, type McpTool } from "./mcp.js";
import { isUuid, LOGIN_CODE_RE, newSecret, normalizeLoginCode, safeEqual, uuidv7 } from "./ids.js";
import { ANONYMOUS, noopMetrics, type Metrics } from "./metrics.js";
import { USERNAME_PROBLEM_MESSAGES, type SlugProblem } from "./slugs.js";
import { sources } from "./sources.js";
import * as store from "./store.js";
import type { MessageRow, Source, User } from "./store.js";
import { secretBox } from "./secrets.js";
import { signSessionToken, verifyToken } from "./tokens.js";
import { createWeb } from "./ui.js";

export interface ApiOptions {
  getDb: () => Promise<Db>;
  /** Base for inbox URLs. Defaults to the request origin. */
  publicBaseUrl?: string;
  /**
   * No new accounts (`SIGNUPS=closed`): an email with no user can't log in. Existing users are unaffected.
   */
  signupsClosed?: boolean;
  /** Delivers login codes. Defaults to printing them to the console. */
  sendEmail?: SendEmail;
  /** Where the browser sends PostHog events. Defaults to Craftmill's shared proxy. */
  posthogHost?: string;
  /** PostHog project key the browser UI reports to. Unset, the UI sends no metrics. */
  posthogKey?: string;
  /** PostHog's UI host (the toolbar needs it behind a proxy). Defaults to https://us.posthog.com. */
  posthogUiHost?: string;
  /** Vercel Cron's bearer token (`CRON_SECRET`). Unset, /cron/tick refuses every call. */
  cronSecret?: string;
  /** The schedule options (`hour`, `day`, `week`) this deploy offers. Defaults to all three. */
  scheduleOptions?: ScheduleOption[];
  /** Signs session tokens (JWTs). */
  tokenSecret: string;
  /** Encrypts webhook secrets at rest (`INBOX_SECRET_KEY`: 32 bytes, base64). */
  inboxSecretKey: string;
  /** Product metrics. Defaults to recording nothing. */
  metrics?: Metrics;
  /** The oldest CLI version still served (e.g. "0.2.0"). Older ones get 426 `cli_outdated`. Unset, none is turned away. */
  minCliVersion?: string;
}

export const SCHEDULE_OPTIONS = ["hour", "day", "week"] as const;
export type ScheduleOption = (typeof SCHEDULE_OPTIONS)[number];

/** Reads `SCHEDULE_OPTIONS` (e.g. "hour,day,week"). Unset or empty means `day,week`, which a Vercel Hobby cron can drive. */
export function parseScheduleOptions(value: string | undefined): ScheduleOption[] {
  const names = (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const bad = names.find((n) => !SCHEDULE_OPTIONS.includes(n as ScheduleOption));
  if (bad) throw new Error(`SCHEDULE_OPTIONS: unknown option "${bad}" (use ${SCHEDULE_OPTIONS.join(", ")})`);
  return names.length ? SCHEDULE_OPTIONS.filter((o) => names.includes(o)) : ["day", "week"];
}

/** How often a schedule's config runs, if it has one. */
const everyOf = (config: unknown) => (config as { schedule?: { every?: ScheduleOption } } | null)?.schedule?.every;

export function createApi(opts: ApiOptions) {
  const box = secretBox(opts.inboxSecretKey);
  const app = new Hono<Env>();
  const metrics = opts.metrics ?? noopMetrics;
  const scheduleOptions = opts.scheduleOptions ?? [...SCHEDULE_OPTIONS];

  /** Refuses a schedule config whose option this deploy has turned off. Keeping a source's current option is fine. */
  async function requireScheduleOption(
    c: Context<Env>,
    sourceType: string,
    config: unknown,
    action: string,
    before?: unknown,
  ) {
    const every = sourceType === "schedule" ? everyOf(config) : undefined;
    if (!every || scheduleOptions.includes(every) || every === everyOf(before)) return;
    await metrics.capture("schedule_option_rejected", c.get("user")?.id ?? ANONYMOUS, { option: every, action });
    throw new ApiError(
      400,
      "schedule_option_disabled",
      `This deploy doesn't offer "${every}" schedules. Available: ${scheduleOptions.join(", ")}`,
    );
  }

  // Every error response is counted by its code, so the metrics show where requests stop.
  const failed = (c: Context<Env>, code: string, status: number) =>
    metrics.capture("api_error", c.get("user")?.id ?? ANONYMOUS, {
      code,
      status,
      cli_version: cliVersion(c),
      method: c.req.method,
      route: c.req.routePath,
      ...(c.get("path") && { path: c.get("path") }),
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

  app.use(async (c, next) => {
    c.set("db", await opts.getDb());
    await next();
  });

  // ---------- Public ----------

  // Every JSON route lives on `api`, served under /api so it can't clash with a page.
  const api = new Hono<Env>();

  // The CLI names its version on every request. Requests without it (webhooks, the web UI) are never turned away.
  api.use(async (c, next) => {
    const version = cliVersion(c);
    if (opts.minCliVersion && version !== "none" && olderThan(version, opts.minCliVersion)) {
      // This runs before auth, so look the token up here (never failing) to count the rejection under its user.
      const token = bearer(c);
      const user = token ? await userForToken(c.var.db, token).catch(() => undefined) : undefined;
      if (user) c.set("user", user);
      c.set("path", c.req.path.replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{27}|\d+)(?=\/|$)/gi, "/:id"));
      throw new ApiError(
        426,
        "cli_outdated",
        `This loopway CLI (${version}) is too old; ${opts.minCliVersion} or newer is needed. Update it: curl -fsSL ${baseUrl(c)}/install.sh | sh`,
      );
    }
    await next();
  });

  app.route(
    "/",
    createWeb({
      metrics,
      publicBaseUrl: opts.publicBaseUrl,
      posthogKey: opts.posthogKey,
      posthogHost: opts.posthogHost,
      posthogUiHost: opts.posthogUiHost ?? "https://us.posthog.com",
    }),
  );

  api.get("/", (c) => c.json({ ok: true }));

  api.get("/health", async (c) => {
    await c.var.db.query("SELECT 1");
    return c.json({ ok: true });
  });

  // A user's one inbox URL. The delivery says who sent it by the way it's signed: every source of the user whose sender
  // claims it is tried in turn, because a user can have several of one type (two GitHub orgs, two secrets). A delivery
  // that none of them verifies is refused and not stored, so this public URL can't be used to fill someone's inbox.
  api.post("/webhooks/:userId", async (c) => {
    const userId = c.req.param("userId").toLowerCase();
    if (!isUuid(userId) || !(await store.userExists(c.var.db, userId))) {
      throw new ApiError(404, "not_found", "Inbox not found");
    }
    const headers = c.req.raw.headers;
    const claimed = (await store.listSources(c.var.db, userId)).filter((row) => {
      const source = sources.get(row.source_type);
      return row.secret_enc && source?.receive && source.claims?.(headers);
    });
    const received = (outcome: string, extra?: Record<string, unknown>) =>
      metrics.capture("webhook_received", userId, { outcome, tried: claimed.length, ...extra });
    if (!claimed.length) {
      await received("unverified");
      throw new ApiError(401, "unverified", "No registered source verifies this delivery");
    }
    const rawBody = await c.req.text();
    const receivedAt = new Date();
    const url = inboxUrl(c, userId);
    let unreadable = false;

    for (const row of claimed) {
      const source_type = row.source_type;
      let secret: string;
      try {
        secret = box.open(row.secret_enc!, row.id);
      } catch (err) {
        // No key on this deploy, or one that doesn't open this secret: not the sender's fault, but another source may
        // still verify it, so carry on, and say so only if none does.
        console.error(err);
        unreadable = true;
        continue;
      }
      const result = await sources.get(source_type)!.receive!(
        { headers, rawBody, receivedAt, webhookUrl: url },
        secret,
      );
      if (result.kind === "rejected") {
        // Not noted on the source: this URL is public, so a refused delivery can come from anyone, and with two sources
        // of a sender a good delivery for one is a refusal from the other.
        if (result.status === 401) continue;
        await received("rejected", { source_type, status: result.status });
        throw new ApiError(result.status, "rejected", result.message);
      }
      if (result.kind === "ignored") {
        await recordDelivery(c.var.db, row, `ignored:${result.reason}`);
        await received("ignored", { source_type, reason: result.reason });
        return c.json({ ignored: true, reason: result.reason }, 200);
      }
      const stored = await store.insertMessage(c.var.db, userId, row.id, result.event);
      await recordDelivery(c.var.db, row, "accepted");
      await received(stored.duplicate ? "duplicate" : "accepted", { source_type });
      return c.json({ id: stored.id, duplicate: stored.duplicate }, stored.duplicate ? 200 : 202);
    }
    if (unreadable) {
      await received("failed", { reason: "secret_unreadable" });
      throw new ApiError(500, "internal", "Internal server error");
    }
    await received("unverified");
    throw new ApiError(401, "unverified", "No registered source verifies this delivery");
  });

  // Vercel Cron calls this on the schedule in vercel.json (daily by default; hourly where the plan allows) with
  // `Authorization: Bearer $CRON_SECRET`. Every source that fills itself on a clock gets the messages due in the current
  // window, and messages past retention are deleted. Runs in the same window repeat the same CloudEvent ids, so they
  // are stored once.
  api.get("/cron/tick", async (c) => {
    const token = bearer(c);
    if (!opts.cronSecret || !token || !safeEqual(token, opts.cronSecret)) {
      await metrics.capture("schedule_tick_rejected", ANONYMOUS, { reason: opts.cronSecret ? "bad_token" : "unset" });
      throw new ApiError(401, "unauthorized", "Missing or wrong cron secret");
    }
    // First, so that schedules that run long can't keep it from happening.
    const purged = await store.purgeMessages(c.var.db);
    const now = new Date();
    const total = { sources: 0, accepted: 0, duplicate: 0, failed: 0, disabled: 0, purged };
    const rejected = new Set<string>();
    for (const row of await store.sourcesOfType(c.var.db, "schedule")) {
      total.sources++;
      // A source made before its option was turned off is skipped, once per option per tick in the metrics.
      const every = everyOf(row.config);
      if (every && !scheduleOptions.includes(every)) {
        total.disabled++;
        if (!rejected.has(every)) {
          rejected.add(every);
          await metrics.capture("schedule_tick_rejected", ANONYMOUS, { reason: "option_disabled", option: every });
        }
        continue;
      }
      try {
        for (const event of sources.get(row.source_type)!.tick!(row.config, row.id, now)) {
          const { duplicate } = await store.insertMessage(c.var.db, row.user_id, row.id, event);
          total[duplicate ? "duplicate" : "accepted"]++;
        }
      } catch (err) {
        // One bad source (e.g. a config that no longer parses) must not stop the others.
        console.error(err);
        total.failed++;
      }
    }
    await metrics.capture("schedule_ticked", ANONYMOUS, total);
    return c.json(total);
  });

  // Login: email a one-time code, then trade it for a session token (a JWT that lasts 30 days), creating
  // the user if the email is new (only after the code proves they own it).
  // The first step answers the same whether or not a code was already sent.
  // An address gets at most one code per TTL; asking again before it expires sends nothing.
  api.post("/auth/login", async (c) => {
    const { email } = z.object({ email: z.string().trim().email().max(320) }).parse(await jsonBody(c));
    if (opts.signupsClosed && !(await store.emailHasUser(c.var.db, email))) await refuseSignup("login");
    const login = await store.createLoginCode(c.var.db, email);
    await metrics.capture("login_requested", ANONYMOUS, { sent: !!login.code });
    if (login.code) {
      try {
        await (opts.sendEmail ?? consoleSender)({
          to: login.email,
          subject: `Your loopway login code: ${login.code}`,
          text: `Your loopway login code is ${login.code}\n\nIt expires in ${store.LOGIN_CODE_TTL_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
        });
      } catch (err) {
        await store.dropLoginCode(c.var.db, login.email);
        await metrics.capture("login_email_failed", ANONYMOUS);
        throw err;
      }
    }
    return c.json({ sent: true }, 202);
  });

  /** Sign-ups are closed and this would create an account. Counted by the path that tried. */
  async function refuseSignup(path: "login" | "verify"): Promise<never> {
    await metrics.capture("signup_refused", ANONYMOUS, { path });
    throw new ApiError(
      403,
      "signups_closed",
      "Loopway is no longer accepting new accounts. Existing accounts can still log in.",
    );
  }

  const usernameParam = z.string().trim().toLowerCase();

  // Every way a username can be refused, as the API reports it.
  const INVALID = { status: 400, code: "invalid_username" } as const;
  const USERNAME_ERRORS: Record<SlugProblem, { status: 400 | 409; code: string }> = {
    too_short: INVALID,
    too_long: INVALID,
    invalid_chars: INVALID,
    edge_hyphen: INVALID,
    reserved: { status: 400, code: "username_reserved" },
    taken: { status: 409, code: "username_taken" },
  };
  const usernameError = (problem: SlugProblem) =>
    new ApiError(USERNAME_ERRORS[problem].status, USERNAME_ERRORS[problem].code, USERNAME_PROBLEM_MESSAGES[problem]);

  api.post("/auth/verify", async (c) => {
    const input = z
      .object({
        email: z.string().trim().email().max(320),
        code: z.string().transform(normalizeLoginCode).pipe(z.string().regex(LOGIN_CODE_RE)),
        username: usernameParam.optional(),
      })
      .parse(await jsonBody(c));
    if (opts.signupsClosed && !(await store.emailHasUser(c.var.db, input.email))) await refuseSignup("verify");
    const result = await store.redeemLoginCode(c.var.db, input.email, input.code, input.username);
    if ("problem" in result) {
      await metrics.capture("verify_rejected", ANONYMOUS, { reason: result.problem });
      if (result.problem === "invalid_code")
        throw new ApiError(401, "invalid_code", "That code is invalid or has expired");
      if (result.problem === "username_required")
        throw new ApiError(400, "username_required", "This email has no account yet: pick a username to sign up");
      throw usernameError(result.problem);
    }
    // Person properties go with the event so CLI-only users get an email and name too, not just dashboard visitors.
    await metrics.capture(result.created ? "signed_up" : "logged_in", result.user.id, {
      $set: { email: result.user.email, name: result.user.name },
      client: cliVersion(c) === "none" ? "web" : "cli",
    });
    const { token, expiresAt } = signSessionToken(result.user.id, opts.tokenSecret);
    return c.json(
      { token, expires_at: expiresAt.toISOString(), user: serializeUser(result.user), created: result.created },
      201,
    );
  });

  // ---------- Authenticated ----------

  async function userForToken(db: Db, token: string) {
    if (store.isApiToken(token)) return store.apiTokenUser(db, token);
    const claims = verifyToken(token, opts.tokenSecret);
    return claims ? store.userExists(db, claims.sub) : undefined;
  }

  const authed = new Hono<Env>();
  authed.use(async (c, next) => {
    const token = bearer(c);
    const user = token ? await userForToken(c.var.db, token) : undefined;
    if (!user) throw new ApiError(401, "unauthorized", "Missing, invalid or expired token");
    c.set("user", user);
    await next();
  });

  authed.get("/me", async (c) => c.json(serializeUser((await store.findUserById(c.var.db, c.var.user.id))!)));

  // Checking is separate from setting so a form can say "taken" before submit.
  authed.get("/usernames/:username", async (c) => {
    const username = usernameParam.parse(c.req.param("username"));
    const problem = await store.usernameProblem(c.var.db, username, c.var.user.id);
    await metrics.capture("username_checked", c.var.user.id, { result: problem ?? "available" });
    return c.json({
      username,
      available: !problem,
      ...(problem && { reason: problem, message: USERNAME_PROBLEM_MESSAGES[problem] }),
    });
  });

  authed.patch("/me/username", async (c) => {
    const { username } = z.object({ username: usernameParam }).parse(await jsonBody(c));
    const user = (await store.findUserById(c.var.db, c.var.user.id))!;
    const result = await store.setUsername(c.var.db, user.id, username);
    if ("problem" in result) {
      await metrics.capture("username_rejected", user.id, {
        reason: result.problem,
        renaming: !!user.username,
      });
      throw usernameError(result.problem);
    }
    await metrics.capture(user.username ? "username_renamed" : "username_chosen", c.var.user.id);
    return c.json(serializeUser({ ...user, username }));
  });

  // API tokens: long-lived, for what runs unattended (a `loopway poll`, an MCP client). A session lasts 30 days.

  authed.get("/tokens", async (c) => {
    const rows = await store.listApiTokens(c.var.db, c.var.user.id);
    return c.json({ data: rows.map(serializeToken) });
  });

  authed.post("/tokens", async (c) => {
    const { name } = z.object({ name: storableText.trim().min(1).max(100) }).parse(await jsonBody(c));
    const { token, row } = await store.createApiToken(c.var.db, c.var.user.id, name);
    await metrics.capture("api_token_created", c.var.user.id);
    // The one response that carries it: only its hash is stored.
    return c.json({ ...serializeToken(row), token }, 201);
  });

  authed.delete("/tokens/:tokenId", async (c) => {
    const id = c.req.param("tokenId");
    const revoked = isUuid(id) && (await store.revokeApiToken(c.var.db, c.var.user.id, id));
    if (!revoked) throw new ApiError(404, "not_found", "Token not found");
    return c.body(null, 204);
  });

  // The inbox

  authed.get("/inbox", async (c) => {
    const [rows, messages] = await Promise.all([
      store.listSources(c.var.db, c.var.user.id),
      store.countMessages(c.var.db, c.var.user.id),
    ]);
    return c.json({
      url: inboxUrl(c, c.var.user.id),
      sources: rows.length,
      messages,
      retention_days: store.RETENTION_DAYS,
    });
  });

  // Sources: what a user has registered to verify deliveries to their inbox, and the schedules that fill it.

  authed.get("/source-types", (c) => c.json({ data: sources.describe(), schedule_options: scheduleOptions }));

  /** A secret the source's type accepts, or undefined for none given. Throws a 400 for one it can't take. */
  function checkSecret(type: string, secret: string | undefined): string | undefined {
    const origin = sources.get(type)!.secret;
    if (secret === undefined) return undefined;
    if (origin.from === "none") throw new ApiError(400, "invalid_request", `A ${type} source has no secret`);
    if (origin.from === "loopway" && secret.length < origin.minLength) {
      throw new ApiError(400, "invalid_request", `secret must be at least ${origin.minLength} characters`);
    }
    if (origin.from === "sender" && !secret) throw new ApiError(400, "invalid_request", "secret can't be empty");
    if (origin.from === "sender" && origin.pattern && !origin.pattern.test(secret)) {
      throw new ApiError(400, "invalid_request", `That isn't a ${sources.get(type)!.label} signing secret`);
    }
    return secret;
  }

  /** The source's own settings, or 400 for a type that has none. */
  function checkConfig(type: string, input: unknown, existing?: unknown): unknown {
    const source = sources.get(type)!;
    if (source.parseConfig) return source.parseConfig(input, existing);
    if (input !== undefined) throw new ApiError(400, "invalid_request", `A ${type} source has no config`);
    return {};
  }

  const sourceName = storableText.trim().min(1).max(100);

  authed.get("/sources", async (c) => {
    const rows = await store.listSources(c.var.db, c.var.user.id);
    return c.json({ data: rows.map((r) => serializeSource(c, r)) });
  });

  authed.post("/sources", async (c) => {
    const input = z
      .object({
        type: z.string(),
        name: sourceName.optional(),
        secret: z.string().optional(),
        config: z.unknown().optional(),
      })
      .strict()
      .parse(await jsonBody(c));
    const source = sources.get(input.type);
    if (!source) throw new ApiError(400, "invalid_request", `Unknown type. Available: ${sources.types().join(", ")}`);
    const given = checkSecret(source.type, input.secret);
    const config = checkConfig(source.type, input.config);
    await requireScheduleOption(c, source.type, config, "create");
    const made = given === undefined && source.secret.from === "loopway" ? newSecret() : undefined;
    const secret = given ?? made;
    const id = uuidv7();
    let row: Source | undefined;
    try {
      row = await store.createSource(c.var.db, {
        id,
        userId: c.var.user.id,
        name: input.name ?? source.type,
        sourceType: source.type,
        config,
        secretEnc: secret === undefined ? null : box.seal(secret, id),
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw nameTaken(input.name ?? source.type);
      throw err;
    }
    if (!row) {
      throw new ApiError(409, "too_many_sources", `You can register up to ${store.MAX_SOURCES} sources`);
    }
    await metrics.capture("source_registered", c.var.user.id, { source_type: row.source_type });
    // The one response that can carry a secret, and only one loopway made: it has to be copied into the sender now.
    return c.json({ ...serializeSource(c, row), ...(made === undefined ? {} : { secret: made }) }, 201);
  });

  authed.get("/sources/:sourceId", async (c) => c.json(serializeSource(c, await userSource(c))));

  authed.patch("/sources/:sourceId", async (c) => {
    const row = await userSource(c);
    const input = z
      .object({ name: sourceName.optional(), secret: z.string().optional(), config: z.unknown().optional() })
      .strict()
      .parse(await jsonBody(c));
    const secret = checkSecret(row.source_type, input.secret);
    const config = input.config === undefined ? undefined : checkConfig(row.source_type, input.config, row.config);
    if (config !== undefined) await requireScheduleOption(c, row.source_type, config, "update", row.config);
    try {
      const updated = await store.updateSource(c.var.db, row.id, {
        name: input.name,
        config,
        secretEnc: secret === undefined ? undefined : box.seal(secret, row.id),
      });
      return c.json(serializeSource(c, updated));
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw nameTaken(input.name ?? row.name);
      throw err;
    }
  });

  authed.delete("/sources/:sourceId", async (c) => {
    await store.deleteSource(c.var.db, (await userSource(c)).id);
    return c.body(null, 204);
  });

  // Messages

  const readQuery = z
    .object({
      since: z.string().optional(),
      after: z.string().refine(isUuid, "after must be a message id").optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      type: storableText.min(1).max(200).optional(),
    })
    .strict();

  /**
   * One page of a read. `since` is where to start, inclusive: `now`, microseconds since the epoch, or an ISO 8601 time.
   * Left out, it's the oldest message still held. Shared by the HTTP read and the MCP tool, so they can't drift.
   */
  async function readPage(userId: string, input: unknown) {
    const q = readQuery.parse(input);
    const since = q.since === undefined ? "0" : parseSince(q.since);
    if (q.after && (q.since === undefined || since === null)) {
      throw new ApiError(400, "invalid_request", "after needs the since it came back with");
    }
    const page = await store.readMessages(await opts.getDb(), userId, {
      since,
      after: q.after,
      limit: q.limit,
      type: q.type,
    });
    return {
      data: page.messages.map(serializeMessage),
      since: page.since,
      retained_from: page.retainedFrom,
      next_since: page.nextSince,
      next_after: page.nextAfter,
      has_more: page.hasMore,
    };
  }

  const pushInput = z
    .object({
      type: z.string().min(1).max(200),
      subject: z.string().min(1).max(500).optional(),
      id: z.string().min(1).max(200).optional(),
      data: z.unknown().optional(),
    })
    .strict();

  const mcpPushInput = pushInput.omit({ type: true });

  /** Stores a message the user sent. Shared by the HTTP push and the MCP tool. */
  async function pushMessage(userId: string, body: z.infer<typeof pushInput>) {
    const data = body.data === undefined ? undefined : JSON.stringify(body.data);
    if (data !== undefined && Buffer.byteLength(data) > MAX_PUSH_BYTES) {
      throw new ApiError(400, "too_large", `data must be at most ${MAX_PUSH_BYTES} bytes`);
    }
    const now = new Date();
    const event: CloudEvent = makeCloudEvent({
      specversion: "1.0",
      id: body.id ?? uuidv7(now.getTime()),
      source: PUSH_SOURCE,
      type: body.type,
      subject: body.subject,
      time: now.toISOString(),
      datacontenttype: "application/json",
      data: body.data,
    });
    const stored = await store.insertMessage(await opts.getDb(), userId, null, event);
    await metrics.capture("message_pushed", userId, { duplicate: stored.duplicate });
    return stored;
  }

  authed.get("/messages", async (c) => {
    const { order, ...rest } = c.req.query();
    if (order !== undefined && order !== "asc" && order !== "desc") {
      throw new ApiError(400, "invalid_request", "order must be asc or desc");
    }
    if (order !== "desc") return c.json(await readPage(c.var.user.id, rest));
    // The newest few, for looking. A read has a cursor; this doesn't, so it takes nothing a cursor needs.
    if (rest.since !== undefined || rest.after !== undefined) {
      throw new ApiError(400, "invalid_request", "order=desc shows the newest messages and takes no since or after");
    }
    const q = readQuery.parse(rest);
    const rows = await store.latestMessages(c.var.db, c.var.user.id, { limit: q.limit, type: q.type });
    return c.json({ data: rows.map(serializeMessage), has_more: false });
  });

  authed.post("/messages", async (c) => {
    const stored = await pushMessage(c.var.user.id, pushInput.parse(await jsonBody(c)));
    return c.json(stored, stored.duplicate ? 200 : 202);
  });

  authed.get("/messages/:messageId", async (c) => {
    const id = c.req.param("messageId");
    const row = isUuid(id) ? await store.getMessage(c.var.db, c.var.user.id, id) : undefined;
    if (!row) throw new ApiError(404, "not_found", "Message not found");
    return c.json(serializeMessage(row));
  });

  // MCP: the same push and pull, for agents. Stateless Streamable HTTP: each POST carries its own bearer token.

  const mcpTools = (userId: string): McpTool[] => [
    {
      name: "push_message",
      description:
        "Put a message in your loopway inbox, as a CloudEvent, for whatever reads it. Say what the message is in `subject` and `data`: every push gets the type com.loopway.mcp.message. Give `id` to make repeats of the same message one message.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "What the message is about" },
          id: { type: "string", description: "A dedupe id. Pushing it again stores nothing new." },
          data: { description: "Any JSON" },
        },
        additionalProperties: false,
      },
      call: async (args) =>
        JSON.stringify(await pushMessage(userId, { ...mcpPushInput.parse(args), type: MCP_PUSH_TYPE })),
    },
    {
      name: "pull_messages",
      description:
        "Read messages from your loopway inbox, oldest first, starting at `since`. To carry on, call again with the `next_since` and `next_after` you got back. Delivery is at least once: a message can come twice, so dedupe on its id if that matters.",
      inputSchema: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description:
              "Where to start, inclusive: `now`, microseconds since the epoch, or an ISO 8601 time. Left out, the oldest message still held.",
          },
          after: { type: "string", description: "The next_after from the last call" },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size, default 50" },
          type: { type: "string", description: "An exact CloudEvent type, or a prefix ending in *" },
        },
        additionalProperties: false,
      },
      call: async (args) => JSON.stringify(await readPage(userId, args)),
    },
  ];

  authed.post("/mcp", async (c) => {
    const answer = await handleMcp(await c.req.text(), mcpTools(c.var.user.id));
    if (answer === null) return c.body(null, 202);
    return c.json(answer);
  });
  // No server-to-client stream and no sessions, which the transport lets a server say with a 405.
  for (const method of ["get", "delete"] as const) {
    authed[method]("/mcp", (c) => c.json({ error: { code: "method_not_allowed", message: "POST only" } }, 405));
  }

  api.route("/", authed);
  app.route("/api", api);
  return app;

  // ---------- helpers (closures over opts) ----------

  async function userSource(c: Context<Env>): Promise<Source> {
    const id = c.req.param("sourceId") ?? "";
    const row = isUuid(id) ? await store.getSource(c.var.db, id, c.var.user.id) : undefined;
    if (!row) throw new ApiError(404, "not_found", "Source not found");
    return row;
  }

  function baseUrl(c: Context<Env>) {
    return (opts.publicBaseUrl || new URL(c.req.url).origin).replace(/\/+$/, "");
  }

  function inboxUrl(c: Context<Env>, userId: string) {
    return `${baseUrl(c)}/api/webhooks/${userId}`;
  }

  /** Notes a delivery on the source; the first one is a metric, since it's what shows the sender is connected. */
  async function recordDelivery(db: Db, row: Source, outcome: string) {
    await store.recordDelivery(db, row.id, outcome);
    if (row.last_delivery_at !== null) return;
    await metrics.capture("source_first_delivery", row.user_id, {
      source_type: row.source_type,
      outcome: outcome.split(":")[0],
      seconds_since_created: Math.round((Date.now() - row.created_at.getTime()) / 1000),
    });
  }

  /** The source as the API shows it: never the secret, only whether there is one. */
  function serializeSource(c: Context<Env>, row: Source) {
    const source = sources.get(row.source_type);
    const webhooks = !!source?.receive;
    return {
      id: row.id,
      name: row.name,
      type: row.source_type,
      ...(source?.parseConfig ? { config: row.config } : {}),
      ...(webhooks ? { secret_set: !!row.secret_enc, webhook_url: inboxUrl(c, row.user_id) } : {}),
      webhook_settings: source?.webhookSettings,
      created_at: iso(row.created_at),
      last_delivery_at: iso(row.last_delivery_at),
      last_delivery_outcome: row.last_delivery_outcome,
    };
  }
}

// ---------- module helpers ----------

/** The largest `data` a push takes. */
const MAX_PUSH_BYTES = 1024 * 1024;

/** The CloudEvent `source` of a pushed message. Its ids are unique per user, so a repeat of one is a duplicate. */
const PUSH_SOURCE = "urn:loopway:push";

const MCP_PUSH_TYPE = "com.loopway.mcp.message";

const nameTaken = (name: string) => new ApiError(409, "source_name_taken", `You already have a source named "${name}"`);

/** Text Postgres can store: it has no NUL. */
const storableText = z.string().refine((s) => !s.includes("\0"), "can't contain a NUL character");

const ISO_TIME = /^((\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

/** `now` (null), or a time as microseconds since the epoch. A JS Date stops at milliseconds, so ISO's fraction is kept apart. */
function parseSince(value: string): string | null {
  if (value === "now") return null;
  if (/^\d{1,18}$/.test(value)) return value;
  const m = ISO_TIME.exec(value);
  const ms = m ? Date.parse(m[1]! + m[6]!) : NaN;
  // Date.parse rolls Feb 30 over to March, so the calendar date is checked by making it again.
  const [year, month, day] = m ? [Number(m[2]), Number(m[3]), Number(m[4])] : [0, 0, 0];
  const real = new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
  if (Number.isNaN(ms) || ms < 0 || !real) {
    throw new ApiError(400, "invalid_since", "since must be now, microseconds since the epoch, or an ISO 8601 time");
  }
  return (BigInt(ms) * 1000n + BigInt((m![5] ?? "").padEnd(6, "0"))).toString();
}

function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim();
}

function serializeUser(u: User) {
  return { id: u.id, name: u.name, email: u.email, username: u.username, created_at: iso(u.created_at) };
}

function serializeToken(t: store.ApiToken) {
  return { id: t.id, name: t.name, created_at: iso(t.created_at), last_used_at: iso(t.last_used_at) };
}

function serializeMessage(e: MessageRow) {
  return {
    id: e.id,
    source_id: e.source_id,
    received_at: e.received_at,
    received_us: e.received_us,
    event: e.cloudevent,
  };
}

function iso(d: Date | string | null): string | null {
  if (d == null) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}
