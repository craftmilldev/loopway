import type { BotRule } from "@loopway/rules";
import type { CloudEvent } from "./cloudevents.js";
import type { Db } from "./db/index.js";
import { newLockToken, newLoginCode, normalizeLoginCode, safeEqual, sha256, uuidv7 } from "./ids.js";

/** What a transaction body gets: just `query`, bound to the transaction's connection. */
type Q = Pick<Db, "query">;

// ---------- Users ----------

export interface User {
  id: string;
  name: string;
  email: string | null;
  created_at: Date;
}

export async function createUser(db: Db, input: { name: string; email?: string | null }) {
  const [user] = await db.query<User>(
    `INSERT INTO loopway.users (id, name, email) VALUES ($1, $2, $3)
     RETURNING id, name, email, created_at`,
    [uuidv7(), input.name, input.email ?? null],
  );
  return { user: user! };
}

export async function findUserById(db: Db, id: string): Promise<User | undefined> {
  const [user] = await db.query<User>(`SELECT id, name, email, created_at FROM loopway.users WHERE id = $1`, [id]);
  return user;
}

export const LOGIN_CODE_TTL_MINUTES = 10;
const MAX_LOGIN_ATTEMPTS = 5;

/**
 * Starts a login for this email, whether or not it belongs to a user yet (redeeming the code creates the user).
 * `code` is undefined when one was already issued and hasn't expired: one email per address per TTL,
 * so this can't be used to spam anyone.
 */
export async function createLoginCode(db: Db, email: string): Promise<{ email: string; code?: string }> {
  const addr = email.toLowerCase();
  const code = newLoginCode();
  // email is unique, so concurrent requests can't both get a code.
  await db.query(`DELETE FROM loopway.login_codes WHERE email = $1 AND expires_at <= now()`, [addr]);
  const issued = await db.query(
    `INSERT INTO loopway.login_codes (id, email, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + $4::int * interval '1 minute')
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [uuidv7(), addr, sha256(code), LOGIN_CODE_TTL_MINUTES],
  );
  return { email: addr, code: issued.length ? code : undefined };
}

/**
 * Trades a valid, unexpired code for the user, creating one if the email has none (named after the part before
 * the @). Codes are single-use and die after too many wrong guesses.
 */
export async function redeemLoginCode(
  db: Db,
  email: string,
  code: string,
): Promise<{ user: User; created: boolean } | undefined> {
  const addr = email.toLowerCase();
  const [row] = await db.query<{ id: string; code_hash: string }>(
    `UPDATE loopway.login_codes SET attempts = attempts + 1
     WHERE email = $1 AND expires_at > now() AND attempts < $2
     RETURNING id, code_hash`,
    [addr, MAX_LOGIN_ATTEMPTS],
  );
  if (!row || !safeEqual(row.code_hash, sha256(normalizeLoginCode(code)))) return undefined;
  const [used] = await db.query<{ id: string }>(`DELETE FROM loopway.login_codes WHERE id = $1 RETURNING id`, [row.id]);
  if (!used) return undefined;
  const [existing] = await db.query<User>(
    `SELECT id, name, email, created_at FROM loopway.users WHERE lower(email) = $1`,
    [addr],
  );
  if (!existing) {
    const { user } = await createUser(db, { name: addr.split("@")[0]!, email: addr });
    return { user, created: true };
  }
  return { user: existing, created: false };
}

// ---------- Inboxes ----------

export interface Inbox {
  id: string;
  user_id: string;
  name: string;
  source_type: string;
  config: unknown;
  created_at: Date;
}

export async function createInbox(
  db: Db,
  input: { userId: string; name: string; sourceType: string; config: unknown },
): Promise<Inbox> {
  const [row] = await db.query<Inbox>(
    `INSERT INTO loopway.inboxes (id, user_id, name, source_type, config)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [uuidv7(), input.userId, input.name, input.sourceType, input.config],
  );
  return row!;
}

export async function listInboxes(db: Db, userId: string): Promise<Inbox[]> {
  return db.query<Inbox>(`SELECT * FROM loopway.inboxes WHERE user_id = $1 ORDER BY id`, [userId]);
}

/** Without userId: for webhook ingestion. With userId: enforces ownership. */
export async function getInbox(db: Db, id: string, userId?: string): Promise<Inbox | undefined> {
  const [row] = userId
    ? await db.query<Inbox>(`SELECT * FROM loopway.inboxes WHERE id = $1 AND user_id = $2`, [id, userId])
    : await db.query<Inbox>(`SELECT * FROM loopway.inboxes WHERE id = $1`, [id]);
  return row;
}

export async function updateInbox(db: Db, id: string, patch: { name?: string; config?: unknown }): Promise<Inbox> {
  const [row] = await db.query<Inbox>(
    `UPDATE loopway.inboxes SET
       name   = COALESCE($2, name),
       config = COALESCE($3::jsonb, config)
     WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.config ?? null],
  );
  return row!;
}

export async function deleteInbox(db: Db, id: string): Promise<void> {
  await db.query(`DELETE FROM loopway.inboxes WHERE id = $1`, [id]);
}

export async function inboxStats(db: Db, inboxId: string) {
  const [row] = await db.query<{ messages: number }>(
    `SELECT count(*)::int AS messages FROM loopway.messages WHERE inbox_id = $1`,
    [inboxId],
  );
  return row!;
}

// ---------- Messages ----------

export interface MessageRow {
  id: string;
  inbox_id: string;
  /** bigint; drivers return it as a string or BigInt. */
  seq: string | bigint;
  cloudevent: CloudEvent;
  received_at: Date;
}

const MESSAGE_COLS = `id, inbox_id, seq, cloudevent, received_at`;

/** Returns the stored message and whether it was a redelivery of one we already had (same CE source+id). */
export async function insertMessage(db: Db, inboxId: string, ce: CloudEvent) {
  const [inserted] = await db.query<{ id: string }>(
    `INSERT INTO loopway.messages (id, inbox_id, ce_id, ce_source, ce_type, ce_subject, ce_time, cloudevent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT ON CONSTRAINT messages_ce_unique DO NOTHING
     RETURNING id`,
    [uuidv7(), inboxId, ce.id, ce.source, ce.type, ce.subject ?? null, ce.time ?? null, ce],
  );
  if (inserted) return { id: inserted.id, duplicate: false };
  const [existing] = await db.query<{ id: string }>(
    `SELECT id FROM loopway.messages WHERE inbox_id = $1 AND ce_source = $2 AND ce_id = $3`,
    [inboxId, ce.source, ce.id],
  );
  return { id: existing!.id, duplicate: true };
}

export async function listMessages(
  db: Db,
  inboxId: string,
  opts: { type?: string; after?: string; limit: number; order: "asc" | "desc" },
) {
  const params: unknown[] = [inboxId];
  const where = [`inbox_id = $1`];
  if (opts.type) {
    if (opts.type.endsWith("*")) {
      params.push(opts.type.slice(0, -1).replace(/[\\%_]/g, "\\$&") + "%");
      where.push(`ce_type LIKE $${params.length}`);
    } else {
      params.push(opts.type);
      where.push(`ce_type = $${params.length}`);
    }
  }
  if (opts.after) {
    params.push(opts.after);
    where.push(`id ${opts.order === "asc" ? ">" : "<"} $${params.length}`);
  }
  params.push(opts.limit + 1);
  const rows = await db.query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM loopway.messages WHERE ${where.join(" AND ")}
     ORDER BY id ${opts.order} LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  return { messages: page, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

export async function getMessage(db: Db, inboxId: string, messageId: string): Promise<MessageRow | undefined> {
  const [row] = await db.query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM loopway.messages WHERE id = $1 AND inbox_id = $2`,
    [messageId, inboxId],
  );
  return row;
}

// ---------- Bots ----------

export interface BotVersion {
  version: number;
  prompt: string;
  /** Null for versions saved before bots had rules. */
  rules: BotRule[] | null;
  created_at: string;
}

export interface Bot {
  id: string;
  user_id: string;
  name: string;
  /** The model its sessions run on, as `claude --model` takes it. */
  model: string;
  /** bigint: the `seq` of the last message the bot has read past. */
  cursor: string | bigint;
  inbox_ids: string[];
  /** The bot's newest version of its prompt and assign rules; null for a bot that has none yet. */
  prompt_version: BotVersion | null;
  /** The runner's lease: see leaseBot(). runner_id is who holds it, if the lease asked to say. */
  lock_token: string | null;
  locked_until: Date | null;
  runner_id: string | null;
  created_at: Date;
}

const BOT_COLS = `
  b.id, b.user_id, b.name, b.model, b.cursor, b.lock_token, b.locked_until, b.runner_id, b.created_at,
  COALESCE((SELECT jsonb_agg(bi.inbox_id ORDER BY bi.inbox_id) FROM loopway.bot_inboxes bi WHERE bi.bot_id = b.id),
           '[]'::jsonb) AS inbox_ids,
  (SELECT jsonb_build_object('version', v.version, 'prompt', v.prompt, 'rules', v.rules, 'created_at', v.created_at)
   FROM loopway.bot_versions v WHERE v.bot_id = b.id ORDER BY v.version DESC LIMIT 1) AS prompt_version`;

/**
 * Messages that commit out of seq order (two webhooks landing at once) would be skipped by a cursor that had
 * passed them, so bots don't read anything received this recently, nor anything after it.
 */
export const MESSAGE_HOLDBACK_SECONDS = 5;

// Inbox ids go in as a jsonb array, which both drivers serialize the same way.
const inboxIds = (param: string) => `(SELECT value::uuid FROM jsonb_array_elements_text(${param}::jsonb))`;

/** The inboxes must belong to the user (bot_inboxes' keys enforce it). The cursor starts at their newest message. */
export async function createBot(
  db: Db,
  input: {
    userId: string;
    name: string;
    model: string;
    inboxIds: string[];
    prompt?: string;
    rules?: BotRule[];
  },
): Promise<Bot> {
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO loopway.bots (id, user_id, name, model, cursor)
       VALUES ($1, $2, $3, $5, COALESCE((SELECT max(seq) FROM loopway.messages WHERE inbox_id IN ${inboxIds("$4")}), 0))`,
      [id, input.userId, input.name, input.inboxIds, input.model],
    );
    await tx.query(
      `INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, user_id)
       SELECT $1, ids.value, $2 FROM ${inboxIds("$3")} AS ids(value)`,
      [id, input.userId, input.inboxIds],
    );
    if (input.prompt !== undefined) await addBotVersion(tx, id, input.prompt, input.rules);
  });
  return (await getBot(db, id))!;
}

// Deleted bots keep their row (deleted_at is set), and nothing reads them.

export async function listBots(db: Db, userId: string): Promise<Bot[]> {
  return db.query<Bot>(
    `SELECT ${BOT_COLS} FROM loopway.bots b WHERE b.user_id = $1 AND b.deleted_at IS NULL ORDER BY b.id`,
    [userId],
  );
}

export async function getBot(db: Db, id: string, userId?: string): Promise<Bot | undefined> {
  const [row] = userId
    ? await db.query<Bot>(
        `SELECT ${BOT_COLS} FROM loopway.bots b WHERE b.id = $1 AND b.user_id = $2 AND b.deleted_at IS NULL`,
        [id, userId],
      )
    : await db.query<Bot>(`SELECT ${BOT_COLS} FROM loopway.bots b WHERE b.id = $1 AND b.deleted_at IS NULL`, [id]);
  return row;
}

export interface BotActivity {
  bot_id: string;
  /** One entry per UTC day of the window, oldest first, zero for a day with no deliveries. */
  days: { date: string; delivered: number }[];
  delivered: number;
  /** The newest delivery ever, not only in the window. */
  last_delivery_at: Date | null;
  runs: number;
  /** Seconds from assigned to delivered, median over the messages delivered in the window; null with none. */
  median_wait_seconds: number | null;
}

/**
 * What the user's bots delivered in the last `days` UTC days (today included), for one bot or all. A run is the
 * messages of one thread delivered at the same instant.
 */
export async function botActivity(db: Db, userId: string, days: number, botId?: string): Promise<BotActivity[]> {
  const today = new Date().toISOString().slice(0, 10);
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    return d.toISOString().slice(0, 10);
  });
  const since = dates[0] + "T00:00:00Z";
  const scope = `b.user_id = $1 AND b.deleted_at IS NULL AND ($2::uuid IS NULL OR b.id = $2::uuid)`;
  const [bots, perDay, totals] = await Promise.all([
    db.query<{ id: string }>(`SELECT b.id FROM loopway.bots b WHERE ${scope} ORDER BY b.id`, [userId, botId ?? null]),
    db.query<{ bot_id: string; day: string; n: number }>(
      `SELECT tm.bot_id, to_char(tm.delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
       FROM loopway.thread_messages tm JOIN loopway.bots b ON b.id = tm.bot_id
       WHERE ${scope} AND tm.delivered_at >= $3::timestamptz
       GROUP BY 1, 2`,
      [userId, botId ?? null, since],
    ),
    db.query<{ bot_id: string; last: Date; runs: number; median: number | null }>(
      `SELECT tm.bot_id, max(tm.delivered_at) AS last,
              count(DISTINCT (tm.thread_id, tm.delivered_at)) FILTER (WHERE tm.delivered_at >= $3::timestamptz)::int AS runs,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM tm.delivered_at - tm.assigned_at))
                 FILTER (WHERE tm.delivered_at >= $3::timestamptz))::float8 AS median
       FROM loopway.thread_messages tm JOIN loopway.bots b ON b.id = tm.bot_id
       WHERE ${scope} AND tm.delivered_at IS NOT NULL
       GROUP BY 1`,
      [userId, botId ?? null, since],
    ),
  ]);
  return bots.map(({ id }) => {
    const counts = new Map(perDay.filter((r) => r.bot_id === id).map((r) => [r.day, r.n]));
    const t = totals.find((r) => r.bot_id === id);
    const list = dates.map((date) => ({ date, delivered: counts.get(date) ?? 0 }));
    return {
      bot_id: id,
      days: list,
      delivered: list.reduce((n, d) => n + d.delivered, 0),
      last_delivery_at: t?.last ?? null,
      runs: t?.runs ?? 0,
      median_wait_seconds: t?.median ?? null,
    };
  });
}

/** `inboxIds`, when given, replaces the bot's inboxes. The cursor stays where it is. */
export async function updateBot(
  db: Db,
  bot: Bot,
  patch: { name?: string; model?: string; inboxIds?: string[] },
): Promise<Bot> {
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE loopway.bots SET name = COALESCE($2, name), model = COALESCE($3, model) WHERE id = $1`, [
      bot.id,
      patch.name ?? null,
      patch.model ?? null,
    ]);
    if (patch.inboxIds) {
      await tx.query(`DELETE FROM loopway.bot_inboxes WHERE bot_id = $1 AND inbox_id NOT IN ${inboxIds("$2")}`, [
        bot.id,
        patch.inboxIds,
      ]);
      await tx.query(
        `INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, user_id)
         SELECT $1, ids.value, $2 FROM ${inboxIds("$3")} AS ids(value)
         ON CONFLICT DO NOTHING`,
        [bot.id, bot.user_id, patch.inboxIds],
      );
    }
  });
  return (await getBot(db, bot.id))!;
}

/**
 * Appends a version to the bot and returns it; versions are never changed after. Without `rules` the new version
 * keeps the previous version's.
 */
export async function addBotVersion(db: Q, botId: string, prompt: string, rules?: BotRule[]): Promise<BotVersion> {
  const [row] = await db.query<{ prompt_version: BotVersion }>(
    `INSERT INTO loopway.bot_versions (bot_id, version, prompt, rules)
     SELECT $1, COALESCE(max(version), 0) + 1, $2,
            COALESCE($3::jsonb, (SELECT p.rules FROM loopway.bot_versions p WHERE p.bot_id = $1 ORDER BY p.version DESC LIMIT 1))
     FROM loopway.bot_versions WHERE bot_id = $1
     RETURNING jsonb_build_object('version', version, 'prompt', prompt, 'rules', rules, 'created_at', created_at) AS prompt_version`,
    [botId, prompt, rules ?? null],
  );
  return row!.prompt_version;
}

/** Every version of the bot, newest first. */
export async function listBotVersions(db: Db, botId: string): Promise<BotVersion[]> {
  return db.query<BotVersion>(
    `SELECT version, prompt, rules, created_at FROM loopway.bot_versions WHERE bot_id = $1 ORDER BY version DESC`,
    [botId],
  );
}

export async function deleteBot(db: Db, id: string): Promise<void> {
  await db.query(`UPDATE loopway.bots SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
}

/**
 * Lease the bot to a runner. Succeeds if nobody holds a live lease, or the bot is already leased with
 * `currentToken` (in which case the lease is extended and the token kept).
 */
export async function leaseBot(
  db: Db,
  botId: string,
  ttlSeconds: number,
  currentToken: string | null,
  runnerId: string | null = null,
): Promise<Bot | undefined> {
  const [row] = await db.query<Bot>(
    `UPDATE loopway.bots b SET
       lock_token   = CASE WHEN b.lock_token = $3 THEN b.lock_token ELSE $2 END,
       locked_until = now() + $4::int * interval '1 second',
       runner_id    = $5::uuid
     WHERE b.id = $1 AND b.deleted_at IS NULL
       AND (b.locked_until IS NULL OR b.locked_until <= now() OR b.lock_token = $3)
     RETURNING ${BOT_COLS}`,
    [botId, newLockToken(), currentToken, ttlSeconds, runnerId],
  );
  return row;
}

/** Drops the lease, if `token` is the one held. */
export async function releaseBot(db: Db, botId: string, token: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE loopway.bots SET lock_token = NULL, locked_until = NULL, runner_id = NULL
     WHERE id = $1 AND deleted_at IS NULL AND lock_token = $2
     RETURNING id`,
    [botId, token],
  );
  return rows.length > 0;
}

/** Drops the lease whoever holds it, for a runner that died without releasing. */
export async function forceReleaseBot(db: Db, botId: string): Promise<void> {
  await db.query(
    `UPDATE loopway.bots SET lock_token = NULL, locked_until = NULL, runner_id = NULL WHERE id = $1 AND deleted_at IS NULL`,
    [botId],
  );
}

/** Moves the cursor forward to `seq` (never backwards), if `token` is the live lease. */
export async function advanceCursor(db: Db, botId: string, seq: number, token: string): Promise<Bot | undefined> {
  const [row] = await db.query<Bot>(
    `UPDATE loopway.bots b SET cursor = GREATEST(b.cursor, $2::bigint)
     WHERE b.id = $1 AND b.deleted_at IS NULL AND b.lock_token = $3 AND b.locked_until > now()
     RETURNING ${BOT_COLS}`,
    [botId, seq, token],
  );
  return row;
}

/** Messages in the bot's inboxes after its cursor, oldest first, stopping at the first one still held back. */
export async function botMessages(db: Db, botId: string, limit: number): Promise<MessageRow[]> {
  return db.query<MessageRow>(
    `WITH mine AS (
       SELECT e.* FROM loopway.messages e
       JOIN loopway.bot_inboxes bi ON bi.inbox_id = e.inbox_id
       JOIN loopway.bots b ON b.id = bi.bot_id
       WHERE b.id = $1 AND e.seq > b.cursor
     ),
     fresh AS (SELECT min(seq) AS seq FROM mine WHERE received_at > now() - $2::int * interval '1 second')
     SELECT ${MESSAGE_COLS} FROM mine
     WHERE (SELECT seq FROM fresh) IS NULL OR seq < (SELECT seq FROM fresh)
     ORDER BY seq LIMIT $3`,
    [botId, MESSAGE_HOLDBACK_SECONDS, limit],
  );
}

// ---------- Runners ----------

export interface Runner {
  id: string;
  user_id: string;
  name: string;
  /** The runner's lease: see leaseRunner(). */
  lock_token: string | null;
  locked_until: Date | null;
  created_at: Date;
  last_seen_at: Date;
  /** Bots whose live lease this runner holds. */
  bots: { id: string; name: string }[];
  /** Threads this runner owns. */
  threads: number;
}

const RUNNER_COLS = `
  r.id, r.user_id, r.name, r.lock_token, r.locked_until, r.created_at, r.last_seen_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) ORDER BY b.id) FROM loopway.bots b
            WHERE b.runner_id = r.id AND b.deleted_at IS NULL AND b.locked_until > now()), '[]'::jsonb) AS bots,
  (SELECT count(*)::int FROM loopway.threads t WHERE t.runner_id = r.id) AS threads`;

/** Registers the runner, or renames it and notes it was seen. Undefined if the id is another user's. */
export async function upsertRunner(db: Db, userId: string, id: string, name: string): Promise<Runner | undefined> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO loopway.runners (id, user_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, last_seen_at = now()
     WHERE loopway.runners.user_id = EXCLUDED.user_id
     RETURNING id`,
    [id, userId, name],
  );
  return rows.length ? getRunner(db, userId, id) : undefined;
}

export async function getRunner(db: Db, userId: string, id: string): Promise<Runner | undefined> {
  const [row] = await db.query<Runner>(
    `SELECT ${RUNNER_COLS} FROM loopway.runners r WHERE r.id = $1 AND r.user_id = $2`,
    [id, userId],
  );
  return row;
}

export async function listRunners(db: Db, userId: string): Promise<Runner[]> {
  return db.query<Runner>(
    `SELECT ${RUNNER_COLS} FROM loopway.runners r WHERE r.user_id = $1 ORDER BY r.created_at, r.id`,
    [userId],
  );
}

export async function touchRunner(db: Db, id: string): Promise<void> {
  await db.query(`UPDATE loopway.runners SET last_seen_at = now() WHERE id = $1`, [id]);
}

/**
 * Lease the runner to a process. Succeeds if nobody holds a live lease, or it's already leased with `currentToken`
 * (in which case the lease is extended and the token kept). Only one process uses a runner id at a time.
 */
export async function leaseRunner(
  db: Db,
  userId: string,
  id: string,
  ttlSeconds: number,
  currentToken: string | null,
): Promise<Runner | undefined> {
  const rows = await db.query<{ id: string }>(
    `UPDATE loopway.runners r SET
       lock_token   = CASE WHEN r.lock_token = $4 THEN r.lock_token ELSE $3 END,
       locked_until = now() + $5::int * interval '1 second',
       last_seen_at = now()
     WHERE r.id = $1 AND r.user_id = $2
       AND (r.locked_until IS NULL OR r.locked_until <= now() OR r.lock_token = $4)
     RETURNING r.id`,
    [id, userId, newLockToken(), currentToken, ttlSeconds],
  );
  return rows.length ? getRunner(db, userId, id) : undefined;
}

/** Drops the runner's lease, if `token` is the one held; or whoever's, with `token` null (a process that died). */
export async function releaseRunner(db: Db, userId: string, id: string, token: string | null): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE loopway.runners SET lock_token = NULL, locked_until = NULL
     WHERE id = $1 AND user_id = $2 AND ($3::text IS NULL OR lock_token = $3)
     RETURNING id`,
    [id, userId, token],
  );
  return rows.length > 0;
}

/** The runner whose live lease has this token. */
export async function runnerByToken(db: Db, userId: string, token: string): Promise<Runner | undefined> {
  const [row] = await db.query<Runner>(
    `SELECT ${RUNNER_COLS} FROM loopway.runners r WHERE r.user_id = $1 AND r.lock_token = $2 AND r.locked_until > now()`,
    [userId, token],
  );
  return row;
}

// ---------- Threads ----------

/** Enough about an assigned message to deliver it without fetching it again. */
export interface ThreadMessage {
  id: string;
  inbox_id: string;
  type: string;
  subject: string | null;
}

export interface Thread {
  id: string;
  bot_id: string;
  status: "active" | "ended";
  started: boolean;
  interrupted: boolean;
  limited: boolean;
  /** The runner that owns the thread (see claimThread): its session lives there. Null until a runner claims it. */
  runner_id: string | null;
  subjects: string[];
  /** Assigned, not handed to a run yet. */
  waiting: ThreadMessage[];
  /** Handed to a run that hasn't finished. */
  inflight: ThreadMessage[];
  delivered: number;
  /** Only from getThread(). */
  delivered_ids?: string[];
  /** Only from getThread(): the delivered messages, oldest delivery first. */
  delivered_messages?: { id: string; inbox_id: string; type: string; key: string | null; delivered_at: Date | null }[];
  created_at: Date;
  updated_at: Date;
}

export type ThreadMessageState = "waiting" | "inflight" | "delivered";

const threadMessages = (state: ThreadMessageState) => `
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'inbox_id', m.inbox_id, 'type', m.ce_type, 'subject', tm.subject)
                             ORDER BY tm.assigned_at, m.seq)
            FROM loopway.thread_messages tm JOIN loopway.messages m ON m.id = tm.message_id
            WHERE tm.thread_id = t.id AND tm.state = '${state}'), '[]'::jsonb)`;

const THREAD_COLS = `
  t.id, t.bot_id, t.status, t.started, t.interrupted, t.limited, t.runner_id,
  t.created_at, t.updated_at,
  COALESCE((SELECT jsonb_agg(k.subject ORDER BY k.subject) FROM loopway.thread_subjects k WHERE k.thread_id = t.id),
           '[]'::jsonb) AS subjects,
  ${threadMessages("waiting")} AS waiting,
  ${threadMessages("inflight")} AS inflight,
  (SELECT count(*)::int FROM loopway.thread_messages tm WHERE tm.thread_id = t.id AND tm.state = 'delivered') AS delivered`;

const DELIVERED_IDS = `,
  COALESCE((SELECT jsonb_agg(tm.message_id ORDER BY tm.delivered_at, tm.assigned_at)
            FROM loopway.thread_messages tm WHERE tm.thread_id = t.id AND tm.state = 'delivered'),
           '[]'::jsonb) AS delivered_ids,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'inbox_id', m.inbox_id, 'type', m.ce_type,
                                                'key', tm.subject, 'delivered_at', tm.delivered_at)
                             ORDER BY tm.delivered_at, tm.assigned_at)
            FROM loopway.thread_messages tm JOIN loopway.messages m ON m.id = tm.message_id
            WHERE tm.thread_id = t.id AND tm.state = 'delivered'), '[]'::jsonb) AS delivered_messages`;

/** The runner's live lease on bot $1 with token $2: the condition assign makes inside its own statement. */
const LEASED = `b.id = $1 AND b.deleted_at IS NULL AND b.lock_token = $2 AND b.locked_until > now()`;

// Strings go in as a jsonb array, like inbox ids.
const jsonStrings = (param: string) => `(SELECT value FROM jsonb_array_elements_text(${param}::jsonb))`;

export async function listThreads(db: Db, botId: string, status: "active" | "ended" | "all"): Promise<Thread[]> {
  return db.query<Thread>(
    `SELECT ${THREAD_COLS} FROM loopway.threads t
     WHERE t.bot_id = $1 AND ($2 = 'all' OR t.status = $2) ORDER BY t.created_at, t.id`,
    [botId, status],
  );
}

export async function getThread(db: Db, botId: string, id: string): Promise<Thread | undefined> {
  const [row] = await db.query<Thread>(
    `SELECT ${THREAD_COLS}${DELIVERED_IDS} FROM loopway.threads t WHERE t.id = $1 AND t.bot_id = $2`,
    [id, botId],
  );
  return row;
}

/** Which bot has each of these threads, for the ones that exist. */
export async function threadBots(db: Db, ids: string[]): Promise<Map<string, string>> {
  const rows = await db.query<{ id: string; bot_id: string }>(
    `SELECT id, bot_id FROM loopway.threads WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r.bot_id]));
}

export interface MessageEvent {
  id: string;
  source_type: string;
  cloudevent: CloudEvent;
}

/** The stored event and source type of each of these messages, for the summaries. */
export async function messageEvents(db: Db, ids: string[]): Promise<Map<string, MessageEvent>> {
  if (!ids.length) return new Map();
  const rows = await db.query<MessageEvent>(
    `SELECT m.id, i.source_type, m.cloudevent FROM loopway.messages m JOIN loopway.inboxes i ON i.id = m.inbox_id
     WHERE m.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Each thread's newest `limit` messages (any state), newest first, for finding the thread's title. */
export async function threadNewestEvents(
  db: Db,
  threadIds: string[],
  limit: number,
): Promise<Map<string, MessageEvent[]>> {
  if (!threadIds.length) return new Map();
  const rows = await db.query<MessageEvent & { thread_id: string }>(
    `SELECT t.id AS thread_id, n.id, n.source_type, n.cloudevent
     FROM loopway.threads t CROSS JOIN LATERAL (
       SELECT m.id, m.received_at, m.seq, i.source_type, m.cloudevent
       FROM loopway.thread_messages tm JOIN loopway.messages m ON m.id = tm.message_id
       JOIN loopway.inboxes i ON i.id = m.inbox_id
       WHERE tm.thread_id = t.id ORDER BY m.received_at DESC, m.seq DESC LIMIT $2
     ) n
     WHERE t.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))
     ORDER BY t.id, n.received_at DESC, n.seq DESC`,
    [threadIds, limit],
  );
  const byThread = new Map<string, MessageEvent[]>();
  for (const { thread_id, ...e } of rows) byThread.set(thread_id, [...(byThread.get(thread_id) ?? []), e]);
  return byThread;
}

/** The thread that holds each of these subjects, for the bot's subjects that are taken. */
export async function subjectHolders(db: Db, botId: string, subjects: string[]): Promise<Map<string, string>> {
  const rows = await db.query<{ subject: string; thread_id: string }>(
    `SELECT subject, thread_id FROM loopway.thread_subjects WHERE bot_id = $1 AND subject IN ${jsonStrings("$2")}`,
    [botId, subjects],
  );
  return new Map(rows.map((r) => [r.subject, r.thread_id]));
}

/** The ids among these that are messages in one of the bot's inboxes. */
export async function botMessageIds(db: Db, botId: string, ids: string[]): Promise<Set<string>> {
  const rows = await db.query<{ id: string }>(
    `SELECT m.id FROM loopway.messages m JOIN loopway.bot_inboxes bi ON bi.inbox_id = m.inbox_id
     WHERE bi.bot_id = $1 AND m.id IN (SELECT value::uuid FROM jsonb_array_elements_text($2::jsonb))`,
    [botId, ids],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * The thread's owner holds a live runner lease with token $2: the condition thread writes make inside their statement.
 * Thread $3 of bot $1.
 */
const THREAD_OWNED = `t.id = $3::uuid AND t.bot_id = $1::uuid AND EXISTS (
  SELECT 1 FROM loopway.runners r
  WHERE r.id = t.runner_id AND r.lock_token = $2 AND r.locked_until > now())`;

/**
 * Makes the runner holding the live lease `token` the thread's owner. Fine if it already is; undefined if the
 * thread has another owner, `token` isn't a live runner lease, or the bot has no such thread.
 */
export async function claimThread(
  db: Db,
  userId: string,
  botId: string,
  id: string,
  token: string,
): Promise<Thread | undefined> {
  const rows = await db.query<{ id: string }>(
    `UPDATE loopway.threads t SET runner_id = r.id, updated_at = now()
     FROM loopway.runners r
     WHERE t.id = $4::uuid AND t.bot_id = $1::uuid AND r.user_id = $2::uuid AND t.user_id = r.user_id
       AND r.lock_token = $3 AND r.locked_until > now() AND (t.runner_id IS NULL OR t.runner_id = r.id)
     RETURNING t.id`,
    [botId, userId, token, id],
  );
  return rows.length ? getThread(db, botId, id) : undefined;
}

/** Gives up the thread's owner, so a runner can claim it: the manual move for when its runner is gone. */
export async function releaseThread(db: Db, botId: string, id: string): Promise<void> {
  await db.query(
    `UPDATE loopway.threads SET runner_id = NULL, updated_at = now() WHERE id = $2::uuid AND bot_id = $1::uuid`,
    [botId, id],
  );
}

/** Ends the thread without its runner's lease. Its messages stay as they are, as when the runner ends it. */
export async function endThread(db: Db, botId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const ended = await tx.query<{ user_id: string }>(
      `UPDATE loopway.threads SET status = 'ended', updated_at = now()
       WHERE id = $2::uuid AND bot_id = $1::uuid AND status <> 'ended' RETURNING user_id`,
      [botId, id],
    );
    if (ended.length) await recordThreadEvents(tx, ended[0]!.user_id, botId, id, ["ended"]);
  });
}

export type ThreadEventKind = "created" | "started" | "ended" | "interrupted" | "limited" | "resumed";

/** Writes one event per kind, for a thread's transitions. */
async function recordThreadEvents(
  db: Pick<Db, "query">,
  userId: string,
  botId: string,
  threadId: string,
  kinds: ThreadEventKind[],
) {
  if (!kinds.length) return;
  await db.query(
    `INSERT INTO loopway.thread_events (user_id, bot_id, thread_id, kind)
     SELECT $1::uuid, $2::uuid, $3::uuid, k.value FROM jsonb_array_elements_text($4::jsonb) WITH ORDINALITY k(value, n)
     ORDER BY k.n`,
    [userId, botId, threadId, kinds],
  );
}

export interface ThreadEvent {
  id: string;
  kind: ThreadEventKind;
  at: Date;
  bot_id: string;
  bot_name: string;
  thread_id: string;
  subjects: string[];
}

/** The user's thread events, newest first, after the event `before` (an id from a previous page) if given. */
export async function listThreadEvents(db: Db, userId: string, limit: number, before?: string): Promise<ThreadEvent[]> {
  return db.query<ThreadEvent>(
    `SELECT e.id::text, e.kind, e.at, e.bot_id, b.name AS bot_name, e.thread_id,
            COALESCE((SELECT jsonb_agg(k.subject ORDER BY k.subject) FROM loopway.thread_subjects k
                      WHERE k.thread_id = e.thread_id), '[]'::jsonb) AS subjects
     FROM loopway.thread_events e JOIN loopway.bots b ON b.id = e.bot_id
     WHERE e.user_id = $1::uuid AND b.deleted_at IS NULL
       AND ($3::bigint IS NULL
            OR (e.at, e.id) < (SELECT p.at, p.id FROM loopway.thread_events p WHERE p.id = $3::bigint AND p.user_id = $1::uuid))
     ORDER BY e.at DESC, e.id DESC LIMIT $2`,
    [userId, limit, before ?? null],
  );
}

export interface Assignment {
  message_id: string;
  thread_id: string;
  add_subjects?: string[];
  subject?: string;
}

/**
 * One transaction, so it's atomic: creates the threads the bot doesn't have yet, adds subjects, inserts the messages as
 * waiting (one already assigned is skipped) and advances the cursor. Does nothing, and returns undefined, unless
 * `token` is the live lease. Callers check the ids, subjects and messages first (threadBots and friends).
 */
export async function assignMessages(
  db: Db,
  botId: string,
  token: string,
  cursor: number,
  assignments: Assignment[],
): Promise<{ assigned: number } | undefined> {
  return db.transaction(async (tx) => {
    const [bot] = await tx.query<{ user_id: string }>(
      `UPDATE loopway.bots b SET cursor = GREATEST(b.cursor, $3::bigint)
       WHERE ${LEASED} RETURNING b.user_id`,
      [botId, token, cursor],
    );
    if (!bot) return undefined;
    // The assignments as rows, shared by the three inserts below.
    const a = `(SELECT (x->>'message_id')::uuid AS message_id, (x->>'thread_id')::uuid AS thread_id,
                       x->'add_subjects' AS add_subjects, x->>'subject' AS subject
                FROM jsonb_array_elements($1::jsonb) x)`;
    const created = await tx.query<{ id: string }>(
      `INSERT INTO loopway.threads (id, bot_id, user_id)
       SELECT DISTINCT a.thread_id, $2::uuid, $3::uuid FROM ${a} a
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [assignments, botId, bot.user_id],
    );
    for (const t of created) await recordThreadEvents(tx, bot.user_id, botId, t.id, ["created"]);
    await tx.query(
      `INSERT INTO loopway.thread_subjects (thread_id, bot_id, subject)
       SELECT DISTINCT a.thread_id, $2::uuid, k.subject
       FROM ${a} a CROSS JOIN LATERAL jsonb_array_elements_text(a.add_subjects) AS k(subject)
       ON CONFLICT DO NOTHING`,
      [assignments, botId],
    );
    const msgs = await tx.query(
      `INSERT INTO loopway.thread_messages (thread_id, bot_id, message_id, state, subject)
       SELECT DISTINCT ON (a.message_id) a.thread_id, $2::uuid, a.message_id, 'waiting', a.subject FROM ${a} a
       ON CONFLICT (bot_id, message_id) DO NOTHING RETURNING message_id`,
      [assignments, botId],
    );
    return { assigned: msgs.length };
  });
}

export interface ThreadPatch {
  status?: "active" | "ended";
  started?: boolean;
  interrupted?: boolean;
  limited?: boolean;
  addSubjects?: string[];
}

/** False unless `token` is the live lease of the thread's owner. */
export async function patchThread(
  db: Db,
  botId: string,
  token: string,
  id: string,
  patch: ThreadPatch,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // The old values come back with the update (the self-join sees the row as it was), so an event is written only
    // for a value that changed.
    const upd = await tx.query<{
      user_id: string;
      status: string;
      started: boolean;
      interrupted: boolean;
      limited: boolean;
      old_status: string;
      old_started: boolean;
      old_interrupted: boolean;
      old_limited: boolean;
    }>(
      `UPDATE loopway.threads t SET
         status      = COALESCE($4, t.status),
         started     = COALESCE($5::boolean, t.started),
         interrupted = COALESCE($6::boolean, t.interrupted),
         limited     = COALESCE($7::boolean, t.limited),
         updated_at  = now()
       FROM loopway.threads o
       WHERE o.id = t.id AND ${THREAD_OWNED}
       RETURNING t.user_id, t.status, t.started, t.interrupted, t.limited,
                 o.status AS old_status, o.started AS old_started, o.interrupted AS old_interrupted,
                 o.limited AS old_limited`,
      [botId, token, id, patch.status ?? null, patch.started ?? null, patch.interrupted ?? null, patch.limited ?? null],
    );
    if (!upd.length) return false;
    const u = upd[0]!;
    const kinds: ThreadEventKind[] = [];
    if (u.started && !u.old_started) kinds.push("started");
    if (u.interrupted && !u.old_interrupted) kinds.push("interrupted");
    if (u.limited && !u.old_limited) kinds.push("limited");
    if (!u.limited && u.old_limited) kinds.push("resumed");
    if (u.status === "ended" && u.old_status !== "ended") kinds.push("ended");
    await recordThreadEvents(tx, u.user_id, botId, id, kinds);
    if (patch.addSubjects?.length) {
      await tx.query(
        `INSERT INTO loopway.thread_subjects (thread_id, bot_id, subject)
         SELECT $3::uuid, $1::uuid, k.value FROM ${jsonStrings("$2")} AS k
         ON CONFLICT DO NOTHING`,
        [botId, patch.addSubjects, id],
      );
    }
    return true;
  });
}

/**
 * One transaction: moves `subject` from thread $3 to thread $4 of bot $1, takes the waiting messages for the subject
 * along (inflight and delivered ones stay), and resumes the target if it ended. False unless both are the bot's
 * threads and the subject is on the first.
 */
export async function moveSubject(
  db: Db,
  botId: string,
  subject: string,
  fromThreadId: string,
  toThreadId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // The target must be the bot's thread; the subject UPDATE only matches when it is.
    const moved = await tx.query(
      `UPDATE loopway.thread_subjects k SET thread_id = t.id
       FROM loopway.threads t
       WHERE t.id = $4::uuid AND t.bot_id = $1::uuid
         AND k.bot_id = $1::uuid AND k.subject = $2 AND k.thread_id = $3::uuid
       RETURNING k.subject`,
      [botId, subject, fromThreadId, toThreadId],
    );
    if (!moved.length) return false;
    await tx.query(
      `UPDATE loopway.thread_messages SET thread_id = $4::uuid
       WHERE bot_id = $1::uuid AND thread_id = $3::uuid AND subject = $2 AND state = 'waiting'`,
      [botId, subject, fromThreadId, toThreadId],
    );
    await tx.query(`UPDATE loopway.threads SET status = 'active', updated_at = now() WHERE id = $1::uuid`, [
      toThreadId,
    ]);
    return true;
  });
}

/** Moves the thread's waiting messages to inflight and marks it active. Undefined unless `token` is the live lease of the thread's owner. */
export async function deliverThread(
  db: Db,
  botId: string,
  token: string,
  id: string,
): Promise<ThreadMessage[] | undefined> {
  return db.transaction(async (tx) => {
    const owned = await tx.query(
      `UPDATE loopway.threads t SET status = 'active', updated_at = now()
       WHERE ${THREAD_OWNED} RETURNING t.id`,
      [botId, token, id],
    );
    if (!owned.length) return undefined;
    return tx.query<ThreadMessage>(
      `WITH moved AS (
         UPDATE loopway.thread_messages SET state = 'inflight'
         WHERE thread_id = $1::uuid AND state = 'waiting'
         RETURNING message_id, subject, assigned_at
       )
       SELECT m.id, m.inbox_id, m.ce_type AS type, moved.subject
       FROM moved JOIN loopway.messages m ON m.id = moved.message_id
       ORDER BY moved.assigned_at, m.seq`,
      [id],
    );
  });
}

/** Moves the thread's inflight messages to delivered, or back to waiting. Undefined unless `token` is the live lease of the thread's owner. */
export async function finishThread(
  db: Db,
  botId: string,
  token: string,
  id: string,
  requeue: boolean,
): Promise<{ moved: number } | undefined> {
  return db.transaction(async (tx) => {
    const owned = await tx.query(
      `UPDATE loopway.threads t SET updated_at = now() WHERE ${THREAD_OWNED} RETURNING t.id`,
      [botId, token, id],
    );
    if (!owned.length) return undefined;
    const moved = await tx.query(
      `UPDATE loopway.thread_messages SET
         state        = CASE WHEN $2::boolean THEN 'waiting' ELSE 'delivered' END,
         delivered_at = CASE WHEN $2::boolean THEN NULL ELSE now() END
       WHERE thread_id = $1::uuid AND state = 'inflight' RETURNING message_id`,
      [id, requeue],
    );
    return { moved: moved.length };
  });
}
