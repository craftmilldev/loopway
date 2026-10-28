import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import { checkRules, runnerName, THREAD_MESSAGE_TYPE } from "@loopway/rules";
import { cliVersion, olderThan } from "./cli-version.js";
import { eeRoutes, type EeOptions } from "../ee/routes.js";
import type { Db } from "./db/index.js";
import { consoleSender, type SendEmail } from "./email.js";
import { ApiError, jsonBody, type Env } from "./http.js";
import { makeCloudEvent } from "./cloudevents.js";
import { isUuid, LOGIN_CODE_RE, normalizeLoginCode, safeEqual, uuidv7 } from "./ids.js";
import { ANONYMOUS, noopMetrics, type Metrics } from "./metrics.js";
import { getHarness, HARNESSES } from "@loopway/harnesses";
import { createPosthogProxy } from "./posthog-proxy.js";
import { ORG_SLUG_PROBLEM_MESSAGES, USERNAME_PROBLEM_MESSAGES, type SlugProblem } from "./slugs.js";
import { sources } from "./sources.js";
import * as store from "./store.js";
import type { MessageRow, Inbox, User } from "./store.js";
import { secretBox } from "./secrets.js";
import { signSessionToken, verifyToken } from "./tokens.js";
import { createWeb } from "./ui.js";

/** Carries the runner lease on a read, which has no body for `lease_token`. */
const LEASE_TOKEN_HEADER = "x-lease-token";

export interface ApiOptions extends EeOptions {
  getDb: () => Promise<Db>;
  /** Base for webhook URLs. Defaults to the request origin. */
  publicBaseUrl?: string;
  /** `CRAFTMILL_ENTERPRISE_LICENSE`. The routes under ee/ are commercially licensed and are mounted only when this is set. */
  enterpriseLicense?: string;
  /** `/` redirects to `/login` instead of serving the landing page. */
  selfHosted?: boolean;
  /**
   * Whether the server routes stored messages to threads (default true). Off, only runners do: a switch for a rollout
   * (`SERVER_ROUTING=off`), and for tests of the runner's own routing.
   */
  serverRouting?: boolean;
  /**
   * Keeps the invocation alive for work that continues after the response (Vercel's `waitUntil`): routing a stored
   * message to its bot's threads. Defaults to letting the promise run on its own, which is all a long-lived server needs.
   */
  defer?: (work: Promise<unknown>) => void;
  /** Delivers login codes. Defaults to printing them to the console. */
  sendEmail?: SendEmail;
  /** PostHog cloud region the /api/ingest proxy forwards to. Defaults to "us". */
  posthogRegion?: "us" | "eu";
  /** PostHog project key the browser UI reports to through /api/ingest. Unset, the UI sends no metrics. */
  posthogKey?: string;
  /** PostHog's UI host (the toolbar needs it behind a proxy). Defaults to the region's, https://us.posthog.com. */
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

const DEFAULT_TTL = 300;
const MAX_TTL = 12 * 60 * 60;

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

  /**
   * Routes the bots' messages to threads (see store.routeBot) and records how it went. Never throws: storing a message
   * and answering never depend on routing, and a message routing missed stays past the bot's cursor for the next try.
   */
  async function routeBots(db: Db, botIds: string[], trigger: "ingest" | "catch_up") {
    if (opts.serverRouting === false) return;
    for (const botId of botIds) {
      try {
        const r = await store.routeBot(db, botId, trigger === "ingest");
        if (!r || (r.assigned + r.dropped + r.failed.length === 0 && !r.bad_rules)) continue;
        for (const f of r.failed) console.error(`Routing message ${f.message_id} of bot ${botId} failed: ${f.error}`);
        if (r.bad_rules) console.error(`Bot ${botId} has rules that don't parse, so it isn't routed: ${r.bad_rules}`);
        await metrics.capture("messages_routed", r.org_id, {
          trigger,
          assigned: r.assigned,
          dropped: r.dropped,
          on_runner: r.on_runner,
          unknown_runner: r.unknown_runner,
          rule_errors: r.failed.length,
          bad_rules: !!r.bad_rules,
        });
      } catch (err) {
        console.error(err);
        await metrics.capture("message_routing_failed", ANONYMOUS, { trigger }).catch(() => {});
      }
    }
  }

  /** After the response, routes what was just stored in these inboxes to the threads of the bots that read them. */
  function routeAfter(db: Db, inboxIds: string[]) {
    if (opts.serverRouting === false) return;
    const work = store
      .botsOfInboxes(db, inboxIds)
      .then((botIds) => routeBots(db, botIds, "ingest"))
      .catch(async (err) => {
        console.error(err);
        await metrics.capture("message_routing_failed", ANONYMOUS, { trigger: "ingest" }).catch(() => {});
      });
    (opts.defer ?? ((p) => void p))(work);
  }

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

  // Registered before the db middleware: forwarding analytics needs no database.
  app.route("/", createPosthogProxy({ region: opts.posthogRegion }));

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
      selfHosted: opts.selfHosted,
      publicBaseUrl: opts.publicBaseUrl,
      posthogKey: opts.posthogKey,
      posthogUiHost:
        opts.posthogUiHost ?? (opts.posthogRegion === "eu" ? "https://eu.posthog.com" : "https://us.posthog.com"),
    }),
  );

  api.get("/", (c) => c.json({ ok: true }));

  api.get("/health", async (c) => {
    await c.var.db.query("SELECT 1");
    return c.json({ ok: true });
  });

  api.post("/webhooks/:inboxId", async (c) => {
    const inboxId = c.req.param("inboxId");
    const inbox = isUuid(inboxId) ? await store.getInbox(c.var.db, inboxId) : undefined;
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
    inbox: Inbox,
    delivery: { headers: Headers; rawBody: string },
    test: boolean,
  ): Promise<{ kind: "ignored"; reason: string } | { kind: "stored"; id: string; seq: number; duplicate: boolean }> {
    const source = sources.get(inbox.source_type);
    if (!source) throw new ApiError(500, "internal", `Unknown source type ${inbox.source_type}`);
    const received = async (outcome: string, extra?: Record<string, unknown>) => {
      await metrics.capture("webhook_received", inbox.org_id, {
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
    if (!stored.duplicate) routeAfter(c.var.db, [inbox.id]);
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
    const routed = new Set<string>();
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
          if (!duplicate) routed.add(inbox.id);
          await metrics.capture("schedule_message", inbox.org_id, { outcome: duplicate ? "duplicate" : "accepted" });
        }
      } catch (err) {
        // One bad inbox (e.g. a config that no longer parses) must not stop the others.
        console.error(err);
        total.failed++;
        await metrics.capture("schedule_message", inbox.org_id, { outcome: "failed" });
      }
    }
    if (routed.size) routeAfter(c.var.db, [...routed]);
    await metrics.capture("schedule_ticked", ANONYMOUS, total);
    return c.json(total);
  });

  // Login: email a one-time code, then trade it for a session token (a JWT that lasts 30 days), creating
  // the user if the email is new (only after the code proves they own it).
  // The first step answers the same whether or not a code was already sent.
  // An address gets at most one code per TTL; asking again before it expires sends nothing.
  api.post("/auth/login", async (c) => {
    const { email } = z.object({ email: z.string().trim().email().max(320) }).parse(await jsonBody(c));
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
    if (result.joined) await metrics.capture("org_invites_claimed", result.user.id, { orgs: result.joined });
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

  // Usernames are personal-org slugs. Checking is separate from setting so a form can say "taken" before submit.
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

  // Sets the username, which also makes the personal org for a new signup. After that it renames the org's slug.
  authed.patch("/me/username", async (c) => {
    const { username } = z.object({ username: usernameParam }).parse(await jsonBody(c));
    const result = await store.setUsername(c.var.db, c.var.user.id, username);
    if ("problem" in result) {
      await metrics.capture("username_rejected", c.var.user.id, {
        reason: result.problem,
        renaming: !!c.var.user.username,
      });
      throw usernameError(result.problem);
    }
    await metrics.capture(result.created ? "username_chosen" : "username_renamed", c.var.user.id);
    return c.json(serializeUser({ ...c.var.user, username }));
  });

  authed.get("/orgs", async (c) => c.json({ data: await store.listOrgs(c.var.db, c.var.user.id) }));

  // Creates a shared org with the caller as its only member. Its slug follows the username rules and error codes.
  authed.post("/orgs", async (c) => {
    const input = z
      .object({ slug: usernameParam, name: z.string().trim().min(1).max(100).optional() })
      .parse(await jsonBody(c));
    const result = await store.createSharedOrg(c.var.db, c.var.user.id, input.slug, input.name);
    if ("problem" in result) {
      await metrics.capture("org_create_rejected", c.var.user.id, { reason: result.problem });
      const { status, code } = USERNAME_ERRORS[result.problem];
      throw new ApiError(status, code, ORG_SLUG_PROBLEM_MESSAGES[result.problem]);
    }
    await metrics.capture("org_created", c.var.user.id, { named: !!input.name });
    return c.json(result.org, 201);
  });

  // Whether a slug can be used for a new org, so a form can say "taken" before submit. Your own username is taken.
  authed.get("/orgs/:slug/available", async (c) => {
    const slug = usernameParam.parse(c.req.param("slug"));
    const problem = await store.usernameProblem(c.var.db, slug);
    await metrics.capture("org_slug_checked", c.var.user.id, { result: problem ?? "available" });
    return c.json({
      slug,
      available: !problem,
      ...(problem && { reason: problem, message: ORG_SLUG_PROBLEM_MESSAGES[problem] }),
    });
  });

  // Org members. Only members may see or change them; anyone else gets the 404 a missing org gets.

  async function memberOrgParam(c: Context<Env>, action: string): Promise<store.Org> {
    const org = await store.memberOrg(c.var.db, c.var.user.id, c.req.param("slug") ?? "");
    if (!org) {
      await metrics.capture("org_member_rejected", c.var.user.id, { action, reason: "org_not_found" });
      throw new ApiError(404, "not_found", "Org not found");
    }
    return org;
  }

  authed.get("/orgs/:slug/members", async (c) => {
    const org = await memberOrgParam(c, "list");
    return c.json(await store.listOrgMembers(c.var.db, org.id));
  });

  // The org's members have seen the celebration for finishing setup; it isn't shown again.
  authed.post("/orgs/:slug/celebrated", async (c) => {
    const org = await memberOrgParam(c, "celebrated");
    await store.markOrgCelebrated(c.var.db, org.id);
    return c.body(null, 204);
  });

  // Manager threads: the org's chats with its manager. They have no bot, so the bot endpoints never see them. Only
  // the runner that made one, holding its live lease, changes it.
  const metadataSet = z
    .record(z.string().min(1).max(200), z.json())
    .refine((m) => !JSON.stringify(m).includes("\\u0000"), "Metadata can't contain \\u0000");

  authed.get("/orgs/:slug/threads", async (c) => {
    const org = await memberOrgParam(c, "list_threads");
    const { kind } = z.object({ kind: z.enum(["manager", "bot"]).default("manager") }).parse(c.req.query());
    return c.json({ data: (await store.listOrgThreads(c.var.db, org.id, kind)).map(serializeThreadRow) });
  });

  authed.get("/orgs/:slug/threads/:threadId", async (c) => {
    const org = await memberOrgParam(c, "get_thread");
    return c.json(serializeThreadRow(await orgThread(c, org)));
  });

  authed.post("/orgs/:slug/threads", async (c) => {
    const org = await memberOrgParam(c, "create_thread");
    const input = z.object({ id: uuid, lease_token: leaseToken }).parse(await jsonBody(c));
    const runner = await liveRunner(c, input.lease_token);
    if (runner.org_id !== org.id) {
      await metrics.capture("runner_org_mismatch_rejected", c.var.user.id, { action: "manager_thread_create" });
      throw new ApiError(400, "runner_org_mismatch", "A manager thread can only use a runner from its own org");
    }
    const thread = await store.createManagerThread(c.var.db, org.id, input.id, input.lease_token);
    if (!thread) {
      await metrics.capture("manager_thread_rejected", c.var.user.id, { reason: "thread_exists" });
      throw new ApiError(409, "thread_exists", "A thread with that id already exists");
    }
    await metrics.capture("manager_thread_created", c.var.user.id, {});
    return c.json(serializeThreadRow(thread), 201);
  });

  authed.patch("/orgs/:slug/threads/:threadId", async (c) => {
    const org = await memberOrgParam(c, "patch_thread");
    const thread = await orgThread(c, org);
    const input = z
      .object({
        lease_token: leaseToken,
        status: z.enum(["active", "ended"]).optional(),
        // Postgres jsonb can't hold \u0000, in a key or a string value.
        metadata_set: metadataSet.optional(),
        metadata_unset: z.array(z.string().min(1).max(200)).max(100).optional(),
      })
      .parse(await jsonBody(c));
    await requireOwner(c, thread, input.lease_token);
    let patched: boolean;
    try {
      patched = await store.patchManagerThread(c.var.db, org.id, input.lease_token, thread.id, {
        status: input.status,
        metadataSet: input.metadata_set,
        metadataUnset: input.metadata_unset,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "metadata_too_large")
        await metrics.capture("thread_metadata_rejected", c.var.user.id, { reason: "too_large" });
      throw err;
    }
    if (!patched) throw runnerNotLeased();
    if (input.status === "ended" && thread.status !== "ended")
      await metrics.capture("manager_thread_ended", c.var.user.id, {});
    const touched = Object.keys(input.metadata_set ?? {}).length + (input.metadata_unset?.length ?? 0);
    if (touched)
      await metrics.capture("thread_metadata_changed", c.var.user.id, {
        set: Object.keys(input.metadata_set ?? {}).length > 0,
        unset: (input.metadata_unset?.length ?? 0) > 0,
      });
    return c.json(serializeThreadRow((await store.getOrgThread(c.var.db, org.id, thread.id))!));
  });

  authed.post("/orgs/:slug/members", async (c) => {
    const org = await memberOrgParam(c, "add");
    const { email } = z.object({ email: z.string().trim().email().max(320) }).parse(await jsonBody(c));
    const result = await store.addOrgMember(c.var.db, org.id, c.var.user.id, email);
    if (result === "personal_org") {
      await metrics.capture("org_member_rejected", c.var.user.id, { action: "add", reason: "personal_org" });
      throw new ApiError(409, "personal_org", "A personal org can't have other members");
    }
    await metrics.capture("org_member_added", c.var.user.id, { result, personal: org.personal });
    return c.json(
      await store.listOrgMembers(c.var.db, org.id),
      result === "member" || result === "pending" ? 201 : 200,
    );
  });

  // Registered before the :userId route, which would take "pending" for an id.
  authed.delete("/orgs/:slug/members/pending", async (c) => {
    const org = await memberOrgParam(c, "remove_pending");
    const { email } = z.object({ email: z.string().trim().email().max(320) }).parse(c.req.query());
    if (!(await store.removeOrgInvite(c.var.db, org.id, email))) {
      await metrics.capture("org_member_rejected", c.var.user.id, { action: "remove_pending", reason: "not_pending" });
      throw new ApiError(404, "not_found", "No pending membership for that email");
    }
    await metrics.capture("org_pending_removed", c.var.user.id);
    return c.body(null, 204);
  });

  authed.delete("/orgs/:slug/members/:userId", async (c) => {
    const org = await memberOrgParam(c, "remove");
    const userId = c.req.param("userId");
    const result = isUuid(userId)
      ? await store.removeOrgMember(c.var.db, org.id, userId.toLowerCase())
      : "not_a_member";
    if (result !== "removed") {
      await metrics.capture("org_member_rejected", c.var.user.id, { action: "remove", reason: result });
      if (result === "personal_owner")
        throw new ApiError(409, "personal_owner", "The owner of a personal org can't be removed from it or leave");
      if (result === "last_member")
        throw new ApiError(409, "last_member", "An org's last member can't be removed or leave");
      throw new ApiError(404, "not_found", "That user is not a member of this org");
    }
    await metrics.capture("org_member_removed", c.var.user.id, {
      self: userId.toLowerCase() === c.var.user.id,
      personal: org.personal,
    });
    return c.body(null, 204);
  });

  // Routes under ee/ are the commercially licensed ones: without a license they aren't mounted, so they 404.
  const ee = !!opts.enterpriseLicense;
  authed.get("/sources", (c) =>
    c.json({
      data: sources.describe(),
      can_request: ee && !!opts.sourceRequests,
      schedule_options: scheduleOptions,
    }),
  );
  if (ee) authed.route("/", eeRoutes(opts, metrics));

  /** The org a create names: 400 without one, 404 (as for any foreign entity) if the user isn't a member. */
  async function createOrg(
    c: Context<Env>,
    kind: "inbox" | "bot" | "runner",
    slug: string | undefined,
  ): Promise<store.Org> {
    if (!slug) {
      await metrics.capture(`${kind}_create_rejected`, c.var.user.id, { reason: "org_required" });
      throw new ApiError(400, "org_required", "org is required: the slug of the org to create it in");
    }
    const org = await store.memberOrg(c.var.db, c.var.user.id, slug);
    if (!org) {
      await metrics.capture(`${kind}_create_rejected`, c.var.user.id, { reason: "org_not_found" });
      throw new ApiError(404, "not_found", "Org not found");
    }
    return org;
  }

  /**
   * The id of the org a list endpoint is scoped to by `?org=<slug>`, so two orgs' records never share a list.
   * 400 without one; a slug the user isn't a member of is a 404, the same whether or not the org exists.
   */
  async function listOrg(c: Context<Env>, endpoint: string): Promise<string> {
    const slug = c.req.query("org");
    if (!slug) {
      await metrics.capture("org_filter_rejected", c.var.user.id, { endpoint, reason: "org_required" });
      throw new ApiError(400, "org_required", "org is required: the slug of the org to list, as ?org=<slug>");
    }
    const org = await store.memberOrg(c.var.db, c.var.user.id, slug);
    if (!org) {
      await metrics.capture("org_filter_rejected", c.var.user.id, { endpoint, reason: "org_not_found" });
      throw new ApiError(404, "not_found", "Org not found");
    }
    return org.id;
  }

  // Inboxes

  authed.get("/inboxes", async (c) => {
    const rows = await store.listInboxes(c.var.db, c.var.user.id, await listOrg(c, "inboxes"));
    return c.json({ data: rows.map((r) => serializeInbox(c, r)) });
  });

  authed.post("/inboxes", async (c) => {
    const input = z
      .object({
        org: z.string().optional(),
        name: z.string().min(1).max(200),
        source_type: z.string(),
        config: z.unknown().optional(),
      })
      .parse(await jsonBody(c));
    const org = await createOrg(c, "inbox", input.org);
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
      orgId: org.id,
      name: input.name,
      sourceType: source.type,
      config,
      secretEnc: secret === undefined ? null : box.seal(secret, id),
    });
    await metrics.capture("inbox_created", c.var.user.id, { source_type: inbox.source_type });
    // The one response that carries the secret: it has to be copied into the sender's settings now.
    return c.json(serializeInbox(c, inbox, secret), 201);
  });

  const activityQuery = z.object({ days: z.coerce.number().int().min(1).max(30).default(14) });

  /** Parses `days`, recording a rejected one under `<kind>_activity_rejected`. */
  async function activityDays(c: Context<Env>, kind: "bot" | "inbox", scope: "all" | "bot" | "one") {
    const q = activityQuery.safeParse(c.req.query());
    if (!q.success) {
      await metrics.capture(`${kind}_activity_rejected`, c.var.user.id, { scope, reason: "invalid_days" });
      throw q.error;
    }
    return q.data.days;
  }

  // Registered before /inboxes/:inboxId, which would take "activity" for an id.
  authed.get("/inboxes/activity", async (c) => {
    const days = await activityDays(c, "inbox", "all");
    const rows = await store.inboxActivity(
      c.var.db,
      c.var.user.id,
      days,
      undefined,
      await listOrg(c, "inbox_activity"),
    );
    await metrics.capture("inbox_activity_viewed", c.var.user.id, { scope: "all", days, inboxes: rows.length });
    return c.json({ data: rows.map(serializeInboxActivity) });
  });

  authed.get("/inboxes/:inboxId/activity", async (c) => {
    const inbox = await memberInbox(c);
    const days = await activityDays(c, "inbox", "one");
    const [row] = await store.inboxActivity(c.var.db, c.var.user.id, days, inbox.id);
    await metrics.capture("inbox_activity_viewed", c.var.user.id, { scope: "one", days, inboxes: 1 });
    return c.json(serializeInboxActivity(row!));
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

  const runnerId = z
    .string()
    .refine(isUuid, "must be a runner id")
    .transform((s) => s.toLowerCase());
  const ttlBody = z.object({ ttl_seconds: z.number().int().min(1).max(MAX_TTL).default(DEFAULT_TTL) });

  authed.get("/inboxes/:inboxId/messages/:messageId", async (c) => {
    const inbox = await memberInbox(c);
    return c.json(serializeMessage(await existingMessage(c, inbox)));
  });

  // A sample event signed with the inbox's own secret and run through the same path as a real delivery, so a new
  // user sees a bot run without setting up the sender first.
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
      routeAfter(c.var.db, [inbox.id]);
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

  // Runners

  authed.get("/runners", async (c) => {
    const rows = await store.listRunners(c.var.db, c.var.user.id, await listOrg(c, "runners"));
    return c.json({ data: rows.map(serializeRunner) });
  });

  // The CLI makes the id and calls this on startup; it is safe to repeat.
  authed.post("/runners", async (c) => {
    const input = z
      .object({ org: z.string().optional(), id: runnerId, name: z.string().min(1).max(200).transform(runnerName) })
      .parse(await jsonBody(c));
    const org = await createOrg(c, "runner", input.org);
    const runner = await store.upsertRunner(c.var.db, c.var.user.id, org.id, input.id, input.name);
    if (!runner) {
      // Only a runner of one of the user's own orgs can be told apart from one that isn't theirs.
      const existing = await store.getRunner(c.var.db, c.var.user.id, input.id);
      await metrics.capture("runner_create_rejected", c.var.user.id, {
        reason: existing ? "org_mismatch" : "id_taken",
      });
      if (existing)
        throw new ApiError(409, "runner_org_mismatch", "That runner belongs to another org; it can't be moved", {
          org: existing.org_slug,
        });
      throw new ApiError(409, "runner_exists", "That runner id is already in use by a runner you can't use");
    }
    if (runner.firstSeconds !== undefined)
      await metrics.capture("org_first_runner_connected", org.id, { seconds: runner.firstSeconds });
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
      await metrics.capture("runner_lease_rejected", runner.org_id, { reason: "leased" });
      throw new ApiError(409, "runner_leased", `Runner is leased until ${until} by another process`, {
        expires_at: until,
      });
    }
    return c.json({ lease: { token: row.lock_token, expires_at: iso(row.locked_until) } });
  });

  // Only where the server routes: with SERVER_ROUTING off a runner has to read each bot's messages itself, which is
  // what a 404 here sends it back to.
  if (opts.serverRouting !== false) {
    // Everything the runner has to do for its bots, in one request: its own threads with waiting messages or a run to
    // resume, and the unowned threads with waiting messages, which it claims (POST .../claim) while it has room.
    authed.get("/runners/:runnerId/work", async (c) => {
      const runner = await routeRunner(c);
      const token = c.req.header(LEASE_TOKEN_HEADER);
      if (!token || (await store.runnerByToken(c.var.db, c.var.user.id, token))?.id !== runner.id) {
        await metrics.capture("runner_work_rejected", runner.org_id, { reason: token ? "not_leased" : "no_token" });
        throw runnerNotLeased();
      }
      const parsed = z
        .object({ bots: z.string().default("") })
        .transform((q) => q.bots.split(",").filter(Boolean))
        .pipe(z.array(uuid).max(100))
        .safeParse(c.req.query());
      if (!parsed.success) {
        await metrics.capture("runner_work_rejected", runner.org_id, { reason: "invalid_bots" });
        throw new ApiError(400, "invalid_request", "bots must be a comma-separated list of up to 100 bot ids");
      }
      const botIds = parsed.data;
      await routeBots(c.var.db, botIds, "catch_up");
      const rows = await store.runnerWork(c.var.db, runner, botIds);
      await metrics.capture("runner_work_listed", runner.org_id, {
        owned: rows.filter((t) => t.runner_id).length,
        claimable: rows.filter((t) => !t.runner_id).length,
      });
      return c.json({ data: await serializeThreads(c.var.db, rows, false) });
    });
  }

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

  const modelBody = z.string().min(1).max(200);
  const harnessNames = HARNESSES.map((h) => h.name);
  const harnessBody = z.string().refine((n) => harnessNames.includes(n), `must be one of: ${harnessNames.join(", ")}`);

  // The model is checked against the harness it will run on, which only the two together can say.
  const checkedModel = async (c: Context<Env>, harness: string, model: string) => {
    if (getHarness(harness).modelFits(model)) return;
    await metrics.capture("bot_model_rejected", c.var.user.id, { harness });
    throw new ApiError(400, "invalid_model", `"${model}" is not a model the ${harness} harness takes`);
  };

  const promptBody = z.string().min(1).max(100_000);

  const expression = z.string().min(1).max(2_000);
  const rulesBody = z
    .array(
      z.strictObject({
        types: z.array(z.string().min(1).max(200)).min(1).max(50),
        subject: expression.optional(),
        related: expression.optional(),
        authorKind: expression.optional(),
        runner: expression.optional(),
        action: expression,
      }),
    )
    .min(1)
    .max(100);

  /** Rejects rules whose expressions don't parse, so a bad edit fails on save and not on a runner. */
  async function checked(c: Context<Env>, rules: z.infer<typeof rulesBody> | undefined, action: "create" | "version") {
    if (!rules) return rules;
    try {
      checkRules(rules);
    } catch (err) {
      await metrics.capture("bot_rules_rejected", c.var.user.id, { action });
      throw new ApiError(400, "invalid_rules", err instanceof Error ? err.message : String(err));
    }
    return rules;
  }

  authed.get("/bots", async (c) => {
    const rows = await store.listBots(c.var.db, c.var.user.id, await listOrg(c, "bots"));
    return c.json({ data: rows.map(serializeBot) });
  });

  authed.get("/bots/activity", async (c) => {
    const days = await activityDays(c, "bot", "all");
    const rows = await store.botActivity(c.var.db, c.var.user.id, days, undefined, await listOrg(c, "bot_activity"));
    await metrics.capture("bot_activity_viewed", c.var.user.id, { scope: "all", days, bots: rows.length });
    return c.json({ data: rows.map(serializeActivity) });
  });

  // What happened to the user's threads, newest first. `before` is the `next` of the previous page.
  authed.get("/events", async (c) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        before: z
          .string()
          .regex(/^\d{1,18}$/)
          .optional(),
      })
      .safeParse(c.req.query());
    if (!q.success) {
      await metrics.capture("thread_events_rejected", c.var.user.id, { reason: "invalid_query" });
      throw q.error;
    }
    const rows = await store.listThreadEvents(
      c.var.db,
      c.var.user.id,
      q.data.limit + 1,
      q.data.before,
      await listOrg(c, "events"),
    );
    const page = rows.slice(0, q.data.limit);
    const newest = await store.threadNewestEvents(c.var.db, [...new Set(page.map((e) => e.thread_id))], TITLE_LOOKBACK);
    const titles = new Map(
      [...newest].map(([id, events]) => [
        id,
        events.map((e) => sources.title(e.source_type, e.cloudevent)).find((title) => title) ?? null,
      ]),
    );
    await metrics.capture("thread_events_viewed", c.var.user.id, {
      paged: !!q.data.before,
      empty: page.length === 0,
      has_more: rows.length > page.length,
    });
    return c.json({
      data: page.map((e) => ({
        id: e.id,
        kind: e.kind,
        at: e.at,
        bot_id: e.bot_id,
        bot_name: e.bot_name,
        thread_id: e.thread_id,
        subjects: e.subjects,
        title: titles.get(e.thread_id) ?? null,
      })),
      next: rows.length > page.length ? page[page.length - 1]!.id : null,
    });
  });

  authed.post("/bots", async (c) => {
    const input = z
      .object({
        org: z.string().optional(),
        name: z.string().min(1).max(200),
        model: modelBody.optional(),
        harness: harnessBody,
        inbox_ids: inboxIdsBody,
        prompt: promptBody.optional(),
        rules: rulesBody.optional(),
      })
      .parse(await jsonBody(c));
    // A script bot has no model; it keeps a placeholder, as the column can't be empty.
    const model = input.model ?? (input.harness === "script" ? "see-script" : undefined);
    if (!model) {
      await metrics.capture("bot_model_rejected", c.var.user.id, { harness: input.harness });
      throw new ApiError(400, "invalid_model", `The ${input.harness} harness needs a model`);
    }
    await checkedModel(c, input.harness, model);
    const org = await createOrg(c, "bot", input.org);
    const bot = await store.createBot(c.var.db, {
      userId: c.var.user.id,
      orgId: org.id,
      name: input.name,
      model,
      harness: input.harness,
      inboxIds: await memberInboxIds(c, input.inbox_ids, org.id),
      prompt: input.prompt,
      rules: await checked(c, input.rules, "create"),
    });
    await metrics.capture("bot_created", c.var.user.id, { has_version: !!bot.prompt_version, harness: bot.harness });
    return c.json(serializeBot(bot), 201);
  });

  authed.get("/bots/:botId", async (c) => c.json(serializeBot(await memberBot(c))));

  authed.get("/bots/:botId/activity", async (c) => {
    const bot = await memberBot(c);
    const days = await activityDays(c, "bot", "bot");
    const [row] = await store.botActivity(c.var.db, c.var.user.id, days, bot.id);
    await metrics.capture("bot_activity_viewed", c.var.user.id, { scope: "bot", days, bots: 1 });
    return c.json(serializeActivity(row!));
  });

  authed.patch("/bots/:botId", async (c) => {
    const bot = await memberBot(c);
    const input = z
      .object({
        name: z.string().min(1).max(200).optional(),
        model: modelBody.optional(),
        harness: harnessBody.optional(),
        inbox_ids: inboxIdsBody.optional(),
      })
      .parse(await jsonBody(c));
    // A script bot's prompt is a shell command and any other bot's is text, so neither can take the other's.
    if (input.harness && input.harness !== bot.harness && (input.harness === "script" || bot.harness === "script")) {
      await metrics.capture("bot_harness_change_rejected", c.var.user.id, { from: bot.harness, to: input.harness });
      throw new ApiError(
        409,
        "harness_not_swappable",
        "A bot can't be switched to or from the script harness; create a new bot",
      );
    }
    // A started thread's session lives in the harness that made it, and another harness can't resume it.
    if (input.harness && input.harness !== bot.harness) {
      const live = (await store.listThreads(c.var.db, bot.id, "active")).filter((t) => t.started).length;
      if (live > 0) {
        await metrics.capture("bot_harness_change_rejected", c.var.user.id, { from: bot.harness, to: input.harness });
        throw new ApiError(409, "harness_in_use", `${live} started thread(s) are still active in ${bot.harness}`);
      }
    }
    // Changing either one has to leave a pair that fits.
    if (input.model || input.harness) await checkedModel(c, input.harness ?? bot.harness, input.model ?? bot.model);
    const updated = await store.updateBot(c.var.db, bot, {
      name: input.name,
      model: input.model,
      harness: input.harness,
      inboxIds: input.inbox_ids && (await memberInboxIds(c, input.inbox_ids, bot.org_id)),
    });
    return c.json(serializeBot(updated));
  });

  authed.get("/bots/:botId/versions", async (c) => {
    const bot = await memberBot(c);
    const rows = await store.listBotVersions(c.var.db, bot.id);
    return c.json({ data: rows.map((v) => ({ ...v, created_at: iso(v.created_at) })) });
  });

  authed.post("/bots/:botId/versions", async (c) => {
    const bot = await memberBot(c);
    const input = z.object({ prompt: promptBody, rules: rulesBody.optional() }).parse(await jsonBody(c));
    const version = await store.addBotVersion(c.var.db, bot.id, input.prompt, await checked(c, input.rules, "version"));
    await metrics.capture("bot_version_saved", c.var.user.id, { with_rules: !!input.rules });
    return c.json(version, 201);
  });

  authed.delete("/bots/:botId", async (c) => {
    const bot = await memberBot(c);
    await store.deleteBot(c.var.db, bot.id);
    return c.body(null, 204);
  });

  authed.get("/bots/:botId/messages", async (c) => {
    const bot = await memberBot(c);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(c.req.query());
    await routeBots(c.var.db, [bot.id], "catch_up");
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
    const bot = await memberBot(c);
    const q = z
      .object({
        status: z.enum(["active", "ended", "all", "pending"]).default("active"),
        titles: z.enum(["true", "false"]).default("true"),
      })
      .parse(c.req.query());
    await routeBots(c.var.db, [bot.id], "catch_up");
    const rows = await store.listThreads(c.var.db, bot.id, q.status);
    return c.json({ data: await serializeThreads(c.var.db, rows, q.titles === "true") });
  });

  authed.get("/bots/:botId/threads/:threadId", async (c) => {
    const bot = await memberBot(c);
    return c.json(await serializeThread(c.var.db, await existingThread(c, bot)));
  });

  authed.post("/bots/:botId/threads/:threadId/claim", async (c) => {
    const bot = await memberBot(c);
    const thread = await existingThread(c, bot);
    const { lease_token } = z.object({ lease_token: leaseToken }).parse(await jsonBody(c));
    const runner = await liveRunner(c, lease_token);
    await requireSameOrg(c, bot, runner, "thread_claim");
    if (thread.runner_id && thread.runner_id !== runner.id) throw threadOwned(thread);
    const claimed = await store.claimThread(c.var.db, c.var.user.id, bot.id, thread.id, lease_token);
    if (!claimed) {
      // Another runner may have claimed it since the read above: first claim wins, and this one is told so.
      const now = await store.getThread(c.var.db, bot.id, thread.id);
      if (now?.runner_id && now.runner_id !== runner.id) {
        await metrics.capture("thread_claim_lost", runner.org_id, {});
        throw threadOwned(now);
      }
      throw runnerNotLeased();
    }
    return c.json(await serializeThread(c.var.db, claimed));
  });

  // The manual move, for when the thread's runner is gone: the thread has no owner until a runner claims it.
  authed.post("/bots/:botId/threads/:threadId/release", async (c) => {
    const bot = await memberBot(c);
    const thread = await existingThread(c, bot);
    await store.releaseThread(c.var.db, bot.id, thread.id);
    return c.json(await serializeThread(c.var.db, (await store.getThread(c.var.db, bot.id, thread.id))!));
  });

  // A member's message to a thread: it lands in one of the bot's inboxes like any other, and the bot's runner routes
  // it to this thread by its subject (the thread's id). It stays inside loopway's own auth.
  authed.post("/bots/:botId/threads/:threadId/messages", async (c) => {
    const bot = await memberBot(c);
    const thread = await existingThread(c, bot);
    const parsed = z.object({ text: z.string().trim().min(1).max(20_000) }).safeParse(await jsonBody(c));
    if (!parsed.success) {
      await metrics.capture("thread_message_rejected", c.var.user.id, { reason: "invalid_text" });
      throw parsed.error;
    }
    const inboxId = bot.inbox_ids[0];
    if (!inboxId) {
      await metrics.capture("thread_message_rejected", c.var.user.id, { reason: "no_inbox" });
      throw new ApiError(409, "no_inbox", "The bot has no inbox to send the message through");
    }
    const sent = await store.insertMessage(
      c.var.db,
      inboxId,
      makeCloudEvent({
        specversion: "1.0",
        id: uuidv7(),
        source: `loopway:threads/${thread.id}`,
        type: THREAD_MESSAGE_TYPE,
        subject: thread.id,
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        data: { thread_id: thread.id, bot_id: bot.id, text: parsed.data.text, user_id: c.var.user.id },
      }),
      false,
    );
    await store.recordDelivery(c.var.db, inboxId, "accepted");
    routeAfter(c.var.db, [inboxId]);
    await metrics.capture("thread_message_sent", c.var.user.id, { thread_status: thread.status });
    return c.json({ id: sent.id, inbox_id: inboxId }, 201);
  });

  // A member's way to end a thread whose work is done or whose runner is gone. Needs no lease, like release; the
  // runner's PATCH still does. Waiting and inflight messages stay as they are, as when a runner ends the thread.
  authed.post("/bots/:botId/threads/:threadId/end", async (c) => {
    const bot = await memberBot(c);
    const thread = await existingThread(c, bot);
    await store.endThread(c.var.db, bot.id, thread.id);
    await metrics.capture("thread_ended_by_owner", c.var.user.id, { already_ended: thread.status === "ended" });
    return c.json(await serializeThread(c.var.db, (await store.getThread(c.var.db, bot.id, thread.id))!));
  });

  authed.patch("/bots/:botId/threads/:threadId", async (c) => {
    const bot = await memberBot(c);
    const thread = await existingThread(c, bot);
    const input = z
      .object({
        lease_token: leaseToken,
        status: z.enum(["active", "ended"]).optional(),
        started: z.boolean().optional(),
        interrupted: z.boolean().optional(),
        limited: z.boolean().optional(),
        add_subjects: threadSubjects.optional(),
        // Postgres jsonb can't hold \u0000, in a key or a string value.
        metadata_set: z
          .record(z.string().min(1).max(200), z.json())
          .refine((m) => !JSON.stringify(m).includes("\\u0000"), "Metadata can't contain \\u0000")
          .optional(),
        metadata_unset: z.array(z.string().min(1).max(200)).max(100).optional(),
      })
      .parse(await jsonBody(c));
    await requireOwner(c, thread, input.lease_token);
    await checkSubjects(
      c,
      bot,
      (input.add_subjects ?? []).map((subject) => ({ subject, threadId: thread.id })),
    );

    const { lease_token, add_subjects, metadata_set, metadata_unset, ...fields } = input;
    const touched = Object.keys(metadata_set ?? {}).length + (metadata_unset?.length ?? 0);
    let patched: boolean;
    try {
      patched = await store.patchThread(c.var.db, bot.id, lease_token, thread.id, {
        ...fields,
        addSubjects: add_subjects,
        metadataSet: metadata_set,
        metadataUnset: metadata_unset,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "metadata_too_large")
        await metrics.capture("thread_metadata_rejected", c.var.user.id, { reason: "too_large" });
      throw err;
    }
    if (!patched) throw runnerNotLeased();
    if (touched)
      await metrics.capture("thread_metadata_changed", c.var.user.id, {
        set: Object.keys(metadata_set ?? {}).length > 0,
        unset: (metadata_unset?.length ?? 0) > 0,
      });
    return c.json(await serializeThread(c.var.db, (await store.getThread(c.var.db, bot.id, thread.id))!));
  });

  // The manual repair for a subject that landed on the wrong thread: from this thread to `to_thread_id`. Needs no lease, like release.
  authed.post("/bots/:botId/threads/:threadId/move-subject", async (c) => {
    const bot = await memberBot(c);
    const from = await existingThread(c, bot);
    const input = z.object({ subject: z.string().min(1).max(500), to_thread_id: uuid }).parse(await jsonBody(c));
    const to = await existingThread(c, bot, input.to_thread_id);
    if (to.id === from.id) throw new ApiError(400, "invalid_request", "The subject is already on that thread");
    if (!(await store.moveSubject(c.var.db, bot.id, input.subject, from.id, to.id)))
      throw new ApiError(404, "not_found", `Subject ${input.subject} isn't on thread ${from.id}`);
    return c.json(await serializeThread(c.var.db, (await store.getThread(c.var.db, bot.id, to.id))!));
  });

  authed.post("/bots/:botId/threads/:threadId/deliver", async (c) => {
    const bot = await memberBot(c);
    const thread = await existingThread(c, bot);
    const { lease_token } = z.object({ lease_token: leaseToken }).parse(await jsonBody(c));
    await requireOwner(c, thread, lease_token);
    const messages = await store.deliverThread(c.var.db, bot.id, lease_token, thread.id);
    if (!messages) throw runnerNotLeased();
    return c.json({ data: messages });
  });

  authed.post("/bots/:botId/threads/:threadId/finish", async (c) => {
    const bot = await memberBot(c);
    const thread = await existingThread(c, bot);
    const { lease_token, requeue } = z
      .object({ lease_token: leaseToken, requeue: z.boolean().optional() })
      .parse(await jsonBody(c));
    await requireOwner(c, thread, lease_token);
    const done = await store.finishThread(c.var.db, bot.id, lease_token, thread.id, requeue ?? false);
    if (!done) throw runnerNotLeased();
    if (done.firstRun)
      await metrics.capture("org_first_bot_ran", done.firstRun.orgId, { seconds: done.firstRun.seconds });
    return c.json({ moved: done.moved });
  });

  api.route("/", authed);
  app.route("/api", api);
  return app;

  // ---------- helpers (closures over opts) ----------

  async function memberBot(c: Context<Env>): Promise<store.Bot> {
    const id = c.req.param("botId") ?? "";
    const bot = isUuid(id) ? await store.getBot(c.var.db, id, c.var.user.id) : undefined;
    if (!bot) throw new ApiError(404, "not_found", "Bot not found");
    return bot;
  }

  /** A bot only runs on a runner of its own org: 400 otherwise. */
  async function requireSameOrg(c: Context<Env>, bot: store.Bot, runner: store.Runner, action: string) {
    if (runner.org_id === bot.org_id) return;
    await metrics.capture("runner_org_mismatch_rejected", c.var.user.id, { action });
    throw new ApiError(400, "runner_org_mismatch", "A bot can only use a runner from its own org");
  }

  /** The runner in the path, if it's in one of the user's orgs. */
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

  async function orgThread(c: Context<Env>, org: store.Org): Promise<store.Thread> {
    const id = c.req.param("threadId") ?? "";
    const thread = isUuid(id) ? await store.getOrgThread(c.var.db, org.id, id.toLowerCase()) : undefined;
    if (!thread) throw new ApiError(404, "not_found", "Thread not found");
    return thread;
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

  /** The ids, deduped, once they're all inboxes in the user's orgs. A bot's inboxes share one org: `orgId` if given (the bot's), else each other's. */
  async function memberInboxIds(c: Context<Env>, ids: string[], orgId?: string): Promise<string[]> {
    const mine = new Map((await store.listInboxes(c.var.db, c.var.user.id)).map((i) => [i.id, i.org_id]));
    const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
    const unknown = wanted.filter((id) => !mine.has(id));
    if (unknown.length) throw new ApiError(400, "invalid_request", `Unknown inbox id(s): ${unknown.join(", ")}`);
    const orgs = new Set(wanted.map((id) => mine.get(id)!));
    if (orgs.size > 1 || (orgId && orgs.size && !orgs.has(orgId))) {
      await metrics.capture("bot_inboxes_rejected", c.var.user.id, { reason: "inbox_org_mismatch" });
      throw new ApiError(400, "inbox_org_mismatch", "A bot's inboxes must all belong to the same org as the bot");
    }
    return wanted;
  }

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
  function fullConfig(inbox: Inbox): unknown {
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

  /** Notes a delivery on the inbox; the first one is a metric, since it's the step that gets a bot its first message. */
  async function recordDelivery(db: Db, inbox: Inbox, outcome: string) {
    const stored = outcome === "duplicate" ? "accepted" : outcome;
    await store.recordDelivery(db, inbox.id, stored);
    if (inbox.last_delivery_at !== null) return;
    await metrics.capture("inbox_first_delivery", inbox.org_id, {
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
      org_id: inbox.org_id,
      created_by: inbox.created_by,
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

function runnerNotLeased(): ApiError {
  return new ApiError(409, "runner_not_leased", "lease_token is not a live runner lease");
}

function threadOwned(t: store.Thread): ApiError {
  return new ApiError(409, "thread_owned", "The thread belongs to another runner", { runner_id: t.runner_id });
}

function serializeRunner(r: store.Runner) {
  return {
    id: r.id,
    org_id: r.org_id,
    created_by: r.created_by,
    org: r.org_slug,
    name: r.name,
    created_at: iso(r.created_at),
    last_seen_at: iso(r.last_seen_at),
    leased_until: r.locked_until && new Date(r.locked_until) > new Date() ? iso(r.locked_until) : null,
    threads: r.threads,
  };
}

/** How many of a thread's newest messages are looked at for its title. */
const TITLE_LOOKBACK = 20;

async function serializeThread(db: Db, t: store.Thread) {
  return (await serializeThreads(db, [t]))[0]!;
}

/**
 * Summaries and titles are computed here from the stored CloudEvents, through the source registry, so a better
 * summary shows on old messages too. A thread's title is the newest title among its last TITLE_LOOKBACK messages.
 */
async function serializeThreads(db: Db, threads: store.Thread[], titles = true) {
  const ids = new Set<string>();
  for (const t of threads)
    for (const m of [...t.waiting, ...t.inflight, ...(t.delivered_messages ?? [])]) ids.add(m.id);
  const [events, newest] = await Promise.all([
    store.messageEvents(db, [...ids]),
    titles
      ? store.threadNewestEvents(
          db,
          threads.map((t) => t.id),
          TITLE_LOOKBACK,
        )
      : new Map<string, store.MessageEvent[]>(),
  ]);
  const summary = (id: string) => {
    const e = events.get(id);
    return e ? sources.summarize(e.source_type, e.cloudevent) : null;
  };
  return threads.map((t) => ({
    ...serializeThreadRow(t),
    // Without titles the field is left out, as an older server would.
    ...(titles
      ? {
          title:
            (newest.get(t.id) ?? []).map((e) => sources.title(e.source_type, e.cloudevent)).find((title) => title) ??
            null,
        }
      : {}),
    waiting: t.waiting.map((m) => ({ ...m, summary: summary(m.id) })),
    inflight: t.inflight.map((m) => ({ ...m, summary: summary(m.id) })),
    ...(t.delivered_messages
      ? { delivered_messages: t.delivered_messages.map((m) => ({ ...m, summary: summary(m.id) })) }
      : {}),
  }));
}

function serializeThreadRow(t: store.Thread) {
  return {
    id: t.id,
    bot_id: t.bot_id,
    kind: t.kind,
    created_by: t.created_by,
    status: t.status,
    started: t.started,
    interrupted: t.interrupted,
    limited: t.limited,
    runner_id: t.runner_id,
    automation_level: t.automation_level,
    metadata: t.metadata,
    subjects: t.subjects,
    delivered: t.delivered,
    ...(t.delivered_ids ? { delivered_ids: t.delivered_ids } : {}),
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
  };
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

function serializeInboxActivity(a: store.InboxActivity) {
  return {
    inbox_id: a.inbox_id,
    days: a.days,
    received: a.received,
    messages: a.messages,
    last_message_at: iso(a.last_message_at),
  };
}

function serializeActivity(a: store.BotActivity) {
  return {
    bot_id: a.bot_id,
    days: a.days,
    delivered: a.delivered,
    last_delivery_at: iso(a.last_delivery_at),
    runs: a.runs,
    median_wait_seconds: a.median_wait_seconds,
    levels: a.levels,
  };
}

function serializeBot(b: store.Bot) {
  return {
    id: b.id,
    org_id: b.org_id,
    created_by: b.created_by,
    name: b.name,
    model: b.model,
    harness: b.harness,
    inbox_ids: b.inbox_ids,
    prompt_version: b.prompt_version,
    cursor: Number(b.cursor),
    created_at: iso(b.created_at),
  };
}

function iso(d: Date | string | null): string | null {
  if (d == null) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}
