import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import { cliVersion, olderThan } from "./cli-version.js";
import type { Db } from "./db/index.js";
import { consoleSender, type SendEmail } from "./email.js";
import { ApiError, jsonBody, type Env } from "./http.js";
import { makeCloudEvent } from "./cloudevents.js";
import { isUuid, LOGIN_CODE_RE, normalizeLoginCode, safeEqual, uuidv7 } from "./ids.js";
import { ANONYMOUS, noopMetrics, type Metrics } from "./metrics.js";
import { USERNAME_PROBLEM_MESSAGES, type SlugProblem } from "./slugs.js";
import { sources } from "./sources.js";
import * as store from "./store.js";
import type { MessageRow, Inbox, User } from "./store.js";
import { secretBox } from "./secrets.js";
import { signSessionToken, verifyToken } from "./tokens.js";
import { createWeb } from "./ui.js";

export interface ApiOptions {
  getDb: () => Promise<Db>;
  /** Base for webhook URLs. Defaults to the request origin. */
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
  /** Vercel Cron's bearer token (`CRON_SECRET`). Unset, /cron/schedules refuses every call. */
  cronSecret?: string;
  /** The schedule options (`hour`, `day`, `week`) this deploy offers. Defaults to all three. */
  scheduleOptions?: ScheduleOption[];
  /** Signs session tokens (JWTs). */
  tokenSecret: string;
  /** Encrypts inbox webhook secrets at rest (`INBOX_SECRET_KEY`: 32 bytes, base64). */
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

/** How often a schedule inbox's config runs, if it has one. */
const everyOf = (config: unknown) => (config as { schedule?: { every?: ScheduleOption } } | null)?.schedule?.every;

export function createApi(opts: ApiOptions) {
  const box = secretBox(opts.inboxSecretKey);
  const app = new Hono<Env>();
  const metrics = opts.metrics ?? noopMetrics;
  const scheduleOptions = opts.scheduleOptions ?? [...SCHEDULE_OPTIONS];

  /** Refuses a schedule config whose option this deploy has turned off. Keeping an inbox's current option is fine. */
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

  api.post("/webhooks/:inboxId", async (c) => {
    const inboxId = c.req.param("inboxId");
    const inbox = isUuid(inboxId) ? await store.deliveryInbox(c.var.db, inboxId) : undefined;
    if (!inbox) throw new ApiError(404, "not_found", "Inbox not found");
    const delivery = { headers: c.req.raw.headers, rawBody: await c.req.text() };
    const result = await deliver(c, inbox, delivery, false);
    if (result.kind === "ignored") return c.json({ ignored: true, reason: result.reason }, 200);
    return c.json({ id: result.id, duplicate: result.duplicate }, result.duplicate ? 200 : 202);
  });

  /**
   * Runs a delivery through its inbox's source and stores the event: what a real webhook and a test message share.
   * A delivery the source refuses throws; `test` marks the stored event (no sender can, so it can't be forged).
   */
  async function deliver(
    c: Context<Env>,
    inbox: store.DeliveryInbox,
    delivery: { headers: Headers; rawBody: string },
    test: boolean,
  ): Promise<{ kind: "ignored"; reason: string } | { kind: "stored"; id: string; seq: number; duplicate: boolean }> {
    const source = sources.get(inbox.source_type);
    if (!source) throw new ApiError(500, "internal", `Unknown source type ${inbox.source_type}`);
    const received = async (outcome: string, extra?: Record<string, unknown>) => {
      await metrics.capture("webhook_received", inbox.user_id, {
        source_type: inbox.source_type,
        outcome,
        test,
        ...extra,
      });
      // Anything that got as far as being checked shows the sender is connected, a rejected delivery included.
      if (outcome === "failed") return;
      const detail = outcome === "rejected" ? extra?.status : outcome === "ignored" ? extra?.reason : undefined;
      await recordDelivery(c.var.db, inbox, detail === undefined ? outcome : `${outcome}:${detail as string | number}`);
    };

    let config: unknown;
    try {
      config = fullConfig(inbox);
    } catch (err) {
      // No key on this deploy, or one that doesn't open this secret: not the sender's fault, so not a 401.
      console.error(err);
      await received("failed", { reason: "secret_unreadable" });
      throw new ApiError(500, "internal", "Internal server error");
    }

    const result = await source.receive(
      { ...delivery, receivedAt: new Date(), webhookUrl: webhookUrl(c, inbox.id) },
      config,
    );
    if (result.kind === "rejected") {
      await received("rejected", { status: result.status });
      throw new ApiError(result.status, "rejected", result.message);
    }
    if (result.kind === "ignored") {
      await received("ignored", { reason: result.reason });
      return { kind: "ignored", reason: result.reason };
    }
    const stored = await store.insertMessage(c.var.db, inbox.id, result.event, test);
    await received(stored.duplicate ? "duplicate" : "accepted");
    return { kind: "stored", ...stored };
  }

  // Vercel Cron calls this on the schedule in vercel.json (daily by default; hourly where the plan allows) with
  // `Authorization: Bearer $CRON_SECRET`. Every inbox whose source fills itself on a clock gets the messages due in
  // the current window. Runs in the same window repeat the same CloudEvent ids, so they are stored once.
  api.get("/cron/schedules", async (c) => {
    const token = bearer(c);
    if (!opts.cronSecret || !token || !safeEqual(token, opts.cronSecret)) {
      await metrics.capture("schedule_tick_rejected", ANONYMOUS, { reason: opts.cronSecret ? "bad_token" : "unset" });
      throw new ApiError(401, "unauthorized", "Missing or wrong cron secret");
    }
    const now = new Date();
    const total = { inboxes: 0, accepted: 0, duplicate: 0, failed: 0, disabled: 0 };
    const rejected = new Set<string>();
    for (const inbox of await store.inboxesOfSource(c.var.db, "schedule")) {
      total.inboxes++;
      // An inbox made before its option was turned off is skipped, once per option per tick in the metrics.
      const every = everyOf(inbox.config);
      if (every && !scheduleOptions.includes(every)) {
        total.disabled++;
        if (!rejected.has(every)) {
          rejected.add(every);
          await metrics.capture("schedule_tick_rejected", ANONYMOUS, { reason: "option_disabled", option: every });
        }
        continue;
      }
      try {
        for (const event of sources.get(inbox.source_type)!.tick!(inbox.config, inbox.id, now)) {
          const { duplicate } = await store.insertMessage(c.var.db, inbox.id, event, false);
          total[duplicate ? "duplicate" : "accepted"]++;
          await metrics.capture("schedule_message", inbox.user_id, { outcome: duplicate ? "duplicate" : "accepted" });
        }
      } catch (err) {
        // One bad inbox (e.g. a config that no longer parses) must not stop the others.
        console.error(err);
        total.failed++;
        await metrics.capture("schedule_message", inbox.user_id, { outcome: "failed" });
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

  authed.get("/sources", (c) =>
    c.json({
      data: sources.describe(),
      schedule_options: scheduleOptions,
    }),
  );

  // Inboxes

  authed.get("/inboxes", async (c) => {
    const rows = await store.listInboxes(c.var.db, c.var.user.id);
    return c.json({ data: rows.map((r) => serializeInbox(c, r)) });
  });

  authed.post("/inboxes", async (c) => {
    const input = z
      .object({
        name: z.string().min(1).max(200),
        source_type: z.string(),
        config: z.unknown().optional(),
      })
      .parse(await jsonBody(c));
    const source = sources.get(input.source_type);
    if (!source) {
      throw new ApiError(400, "invalid_request", `Unknown source_type. Available: ${sources.types().join(", ")}`);
    }
    const full = source.parseConfig(input.config);
    await requireScheduleOption(c, source.type, full, "create");
    const { secret, config } = splitSecret(full);
    const id = uuidv7();
    const inbox = await store.createInbox(c.var.db, {
      id,
      userId: c.var.user.id,
      name: input.name,
      sourceType: source.type,
      config,
      secretEnc: secret === undefined ? null : box.seal(secret, id),
    });
    await metrics.capture("inbox_created", c.var.user.id, { source_type: inbox.source_type });
    // The one response that carries the secret: it has to be copied into the sender's settings now.
    return c.json(serializeInbox(c, inbox, secret), 201);
  });

  authed.get("/inboxes/:inboxId", async (c) => {
    const inbox = await memberInbox(c);
    return c.json({ ...serializeInbox(c, inbox), stats: await store.inboxStats(c.var.db, inbox.id) });
  });

  authed.patch("/inboxes/:inboxId", async (c) => {
    const inbox = await memberInbox(c);
    const input = z
      .object({ name: z.string().min(1).max(200).optional(), config: z.unknown().optional() })
      .parse(await jsonBody(c));
    const source = sources.get(inbox.source_type)!;
    // The stored secret is opened only when parseConfig may keep it: a rename needs nothing, and a new secret
    // replaces one that can't be opened any more (a lost key), which is how that gets recovered.
    const sent = typeof (input.config as { secret?: unknown } | null | undefined)?.secret === "string";
    const existing = input.config === undefined || sent ? inbox.config : await fullConfigOr500(c, inbox);
    const full = input.config === undefined ? undefined : source.parseConfig(input.config, existing);
    if (full !== undefined) await requireScheduleOption(c, inbox.source_type, full, "update", inbox.config);
    const { secret, config } = full === undefined ? ({} as ReturnType<typeof splitSecret>) : splitSecret(full);
    // A secret parseConfig kept is the stored one: only a new one is sealed.
    const changed = secret !== undefined && (sent || secret !== (existing as { secret?: string }).secret);
    const updated = await store.updateInbox(c.var.db, inbox.id, {
      name: input.name,
      config,
      secretEnc: changed ? box.seal(secret, inbox.id) : undefined,
    });
    return c.json(serializeInbox(c, updated));
  });

  authed.delete("/inboxes/:inboxId", async (c) => {
    const inbox = await memberInbox(c);
    await store.deleteInbox(c.var.db, inbox.id);
    return c.body(null, 204);
  });

  // Messages

  authed.get("/inboxes/:inboxId/messages", async (c) => {
    const inbox = await memberInbox(c);
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

  authed.get("/inboxes/:inboxId/messages/:messageId", async (c) => {
    const inbox = await memberInbox(c);
    return c.json(serializeMessage(await existingMessage(c, inbox)));
  });

  // A sample event signed with the inbox's own secret and run through the same path as a real delivery, so a new
  // user sees a message arrive without setting up the sender first.
  authed.post("/inboxes/:inboxId/test", async (c) => {
    const inbox = await memberInbox(c);
    const { from } = z
      .object({ from: z.enum(["inbox_page", "zero_state", "cli"]).default("cli") })
      .parse(await jsonBody(c));
    const fail = async (reason: "secret_not_set" | "no_accepted_type" | "api_error", err: ApiError) => {
      await metrics.capture("test_message_failed", c.var.user.id, { source_type: inbox.source_type, from, reason });
      return err;
    };

    const source = sources.get(inbox.source_type)!;
    const config = (await fullConfigOr500(c, inbox)) as { secret?: string | null; events?: string[] };
    if (source.secret.from === "sender" && !config.secret) {
      throw await fail(
        "secret_not_set",
        new ApiError(
          409,
          "secret_not_set",
          `This inbox has no signing secret yet: paste the one ${source.label} shows first, then send a test message`,
        ),
      );
    }

    const now = new Date();
    const id = uuidv7(now.getTime());
    let message: { id: string; seq: number };
    if (source.tick) {
      // A schedule fills itself: the test is its first message type, under a fresh id so it isn't a repeat of the window's.
      const [event] = source.tick(inbox.config, inbox.id, now);
      if (!event) {
        throw await fail(
          "no_accepted_type",
          new ApiError(422, "no_accepted_type", "This inbox has no message to send"),
        );
      }
      message = await store.insertMessage(c.var.db, inbox.id, makeCloudEvent({ ...event, id }), true);
    } else {
      const type = sources.sampleType(inbox.source_type, config);
      if (!type) {
        throw await fail(
          "no_accepted_type",
          new ApiError(422, "no_accepted_type", "This inbox's events filter accepts none of the types a test can send"),
        );
      }
      const sample = source.sample!(config, { type, id, now });
      try {
        const result = await deliver(c, inbox, { headers: new Headers(sample.headers), rawBody: sample.rawBody }, true);
        if (result.kind === "ignored")
          throw new ApiError(422, "rejected", `The test message was ignored: ${result.reason}`);
        message = result;
      } catch (err) {
        throw err instanceof ApiError ? await fail("api_error", err) : err;
      }
    }
    await metrics.capture("test_message_sent", c.var.user.id, { source_type: inbox.source_type, from });
    return c.json({ message_id: message.id, seq: message.seq }, 201);
  });

  api.route("/", authed);
  app.route("/api", api);
  return app;

  // ---------- helpers (closures over opts) ----------

  async function memberInbox(c: Context<Env>): Promise<Inbox> {
    const id = c.req.param("inboxId") ?? "";
    const inbox = isUuid(id) ? await store.getInbox(c.var.db, id, c.var.user.id) : undefined;
    if (!inbox) throw new ApiError(404, "not_found", "Inbox not found");
    return inbox;
  }

  function baseUrl(c: Context<Env>) {
    return (opts.publicBaseUrl || new URL(c.req.url).origin).replace(/\/+$/, "");
  }

  function webhookUrl(c: Context<Env>, inboxId: string) {
    return `${baseUrl(c)}/api/webhooks/${inboxId}`;
  }

  /** The inbox's config as its source adapter sees it, with the secret opened. Throws if the key can't open it. */
  function fullConfig(inbox: Pick<Inbox, "id" | "config" | "secret_enc">): unknown {
    if (!inbox.secret_enc) return inbox.config;
    return { ...(inbox.config as object), secret: box.open(inbox.secret_enc, inbox.id) };
  }

  async function fullConfigOr500(c: Context<Env>, inbox: Inbox) {
    try {
      return fullConfig(inbox) as never;
    } catch (err) {
      console.error(err);
      await metrics.capture("inbox_secret_failed", c.var.user.id, { action: "open" });
      throw new ApiError(500, "internal", "Internal server error");
    }
  }

  /** Notes a delivery on the inbox; the first one is a metric, since it's the step that gets a reader its first message. */
  async function recordDelivery(db: Db, inbox: store.DeliveryInbox, outcome: string) {
    const stored = outcome === "duplicate" ? "accepted" : outcome;
    await store.recordDelivery(db, inbox.id, stored);
    if (inbox.last_delivery_at !== null) return;
    await metrics.capture("inbox_first_delivery", inbox.user_id, {
      source_type: inbox.source_type,
      outcome: stored.split(":")[0],
      seconds_since_created: Math.round((Date.now() - inbox.created_at.getTime()) / 1000),
    });
  }

  /**
   * The inbox as the API shows it. The secret is never part of it, only whether one is set (`secret_set`), unless
   * `revealed` (the one just made) is passed.
   */
  function serializeInbox(c: Context<Env>, inbox: Inbox, revealed?: string) {
    const source = sources.get(inbox.source_type);
    const url = webhookUrl(c, inbox.id);
    const secret = revealed ?? (inbox.secret_enc ? HIDDEN : undefined);
    const shown = secret === undefined ? inbox.config : { ...(inbox.config as object), secret };
    const publicConfig = source ? (source.publicConfig(shown) as Record<string, unknown>) : { ...(shown as object) };
    if (revealed === undefined) delete publicConfig.secret;
    return {
      id: inbox.id,
      name: inbox.name,
      source_type: inbox.source_type,
      config: { ...publicConfig, ...(source?.secret.from === "none" ? {} : { secret_set: !!inbox.secret_enc }) },
      webhook_url: url,
      setup: source?.setup?.(shown, url),
      created_at: iso(inbox.created_at),
      last_delivery_at: iso(inbox.last_delivery_at),
      last_delivery_outcome: inbox.last_delivery_outcome,
    };
  }
}

// ---------- module helpers ----------

/** What setup instructions show in place of a secret that's already stored. */
const HIDDEN = "(hidden: it was shown once, when the inbox was made)";

/** The config without its webhook secret, which is kept apart and encrypted, and the secret if it had one. */
function splitSecret(full: unknown): { secret?: string; config: Record<string, unknown> } {
  const { secret, ...config } = (full ?? {}) as Record<string, unknown>;
  return typeof secret === "string" ? { secret, config } : { config };
}

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

function serializeUser(u: User) {
  return { id: u.id, name: u.name, email: u.email, username: u.username, created_at: iso(u.created_at) };
}

function serializeMessage(e: MessageRow) {
  return {
    id: e.id,
    inbox_id: e.inbox_id,
    seq: Number(e.seq),
    received_at: iso(e.received_at),
    test: e.is_test,
    event: e.cloudevent,
  };
}

function iso(d: Date | string | null): string | null {
  if (d == null) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}
