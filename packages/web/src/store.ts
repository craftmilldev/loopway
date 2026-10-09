import type { CloudEvent } from "./cloudevents.js";
import type { Db } from "./db/index.js";
import { newLockToken, newLoginCode, normalizeLoginCode, safeEqual, sha256, uuidv7 } from "./ids.js";

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
  const [row] = await db.query<{ pending: number; locked: number; processed: number }>(
    `SELECT
       count(*) FILTER (WHERE processed_at IS NULL AND (locked_until IS NULL OR locked_until <= now()))::int AS pending,
       count(*) FILTER (WHERE processed_at IS NULL AND locked_until > now())::int AS locked,
       count(*) FILTER (WHERE processed_at IS NOT NULL)::int AS processed
     FROM loopway.events WHERE inbox_id = $1`,
    [inboxId],
  );
  return row!;
}

// ---------- Events ----------

export type EventStatus = "pending" | "locked" | "processed";

export interface EventRow {
  id: string;
  inbox_id: string;
  /** bigint; drivers return it as a string or BigInt. */
  seq: string | bigint;
  status: EventStatus;
  cloudevent: CloudEvent;
  received_at: Date;
  lock_token: string | null;
  locked_until: Date | null;
  lock_count: number;
  processed_at: Date | null;
}

const EVENT_COLS = `
  id, inbox_id, seq, cloudevent, received_at, lock_token, locked_until, lock_count, processed_at,
  CASE WHEN processed_at IS NOT NULL THEN 'processed'
       WHEN locked_until > now()     THEN 'locked'
       ELSE 'pending' END AS status`;

const STATUS_WHERE: Record<string, string> = {
  pending: `processed_at IS NULL AND (locked_until IS NULL OR locked_until <= now())`,
  locked: `processed_at IS NULL AND locked_until > now()`,
  processed: `processed_at IS NOT NULL`,
  unprocessed: `processed_at IS NULL`,
  all: `TRUE`,
};
export const LIST_STATUSES = Object.keys(STATUS_WHERE) as [string, ...string[]];

/** Returns the stored event and whether it was a redelivery of one we already had (same CE source+id). */
export async function insertEvent(db: Db, inboxId: string, ce: CloudEvent) {
  const [inserted] = await db.query<{ id: string }>(
    `INSERT INTO loopway.events (id, inbox_id, ce_id, ce_source, ce_type, ce_subject, ce_time, cloudevent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT ON CONSTRAINT events_ce_unique DO NOTHING
     RETURNING id`,
    [uuidv7(), inboxId, ce.id, ce.source, ce.type, ce.subject ?? null, ce.time ?? null, ce],
  );
  if (inserted) return { id: inserted.id, duplicate: false };
  const [existing] = await db.query<{ id: string }>(
    `SELECT id FROM loopway.events WHERE inbox_id = $1 AND ce_source = $2 AND ce_id = $3`,
    [inboxId, ce.source, ce.id],
  );
  return { id: existing!.id, duplicate: true };
}

export async function listEvents(
  db: Db,
  inboxId: string,
  opts: { status: string; type?: string; after?: string; limit: number; order: "asc" | "desc" },
) {
  const params: unknown[] = [inboxId];
  const where = [`inbox_id = $1`, STATUS_WHERE[opts.status] ?? "TRUE"];
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
  const rows = await db.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM loopway.events WHERE ${where.join(" AND ")}
     ORDER BY id ${opts.order} LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  return { events: page, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

export async function getEvent(db: Db, inboxId: string, eventId: string): Promise<EventRow | undefined> {
  const [row] = await db.query<EventRow>(`SELECT ${EVENT_COLS} FROM loopway.events WHERE id = $1 AND inbox_id = $2`, [
    eventId,
    inboxId,
  ]);
  return row;
}

/**
 * Lock one event. Succeeds if it's unprocessed and either unlocked, expired, or already locked with
 * `currentToken` (in which case the lock is extended and the token kept).
 */
export async function lockEvent(
  db: Db,
  inboxId: string,
  eventId: string,
  ttlSeconds: number,
  currentToken: string | null,
): Promise<EventRow | undefined> {
  const [row] = await db.query<EventRow>(
    `UPDATE loopway.events SET
       lock_token   = CASE WHEN lock_token = $4 THEN lock_token ELSE $3 END,
       lock_count   = CASE WHEN lock_token = $4 THEN lock_count ELSE lock_count + 1 END,
       locked_until = now() + $5::int * interval '1 second'
     WHERE id = $1 AND inbox_id = $2 AND processed_at IS NULL
       AND (locked_until IS NULL OR locked_until <= now() OR lock_token = $4)
     RETURNING ${EVENT_COLS}`,
    [eventId, inboxId, newLockToken(), currentToken, ttlSeconds],
  );
  return row;
}

/** Atomically claim the oldest available event. SKIP LOCKED keeps concurrent consumers from colliding. */
export async function claimNext(db: Db, inboxId: string, ttlSeconds: number): Promise<EventRow | undefined> {
  const [row] = await db.query<EventRow>(
    `UPDATE loopway.events SET
       lock_token   = $2,
       lock_count   = lock_count + 1,
       locked_until = now() + $3::int * interval '1 second'
     WHERE id = (
       SELECT id FROM loopway.events
       WHERE inbox_id = $1 AND processed_at IS NULL AND (locked_until IS NULL OR locked_until <= now())
       ORDER BY id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING ${EVENT_COLS}`,
    [inboxId, newLockToken(), ttlSeconds],
  );
  return row;
}

export async function unlockEvent(
  db: Db,
  inboxId: string,
  eventId: string,
  token: string,
): Promise<EventRow | undefined> {
  const [row] = await db.query<EventRow>(
    `UPDATE loopway.events SET lock_token = NULL, locked_until = NULL
     WHERE id = $1 AND inbox_id = $2 AND processed_at IS NULL AND lock_token = $3
     RETURNING ${EVENT_COLS}`,
    [eventId, inboxId, token],
  );
  return row;
}

/** Mark processed. Allowed when the caller holds the lock, or nobody holds a live lock. */
export async function markProcessed(
  db: Db,
  inboxId: string,
  eventId: string,
  token: string | null,
): Promise<EventRow | undefined> {
  const [row] = await db.query<EventRow>(
    `UPDATE loopway.events SET processed_at = now(), lock_token = NULL, locked_until = NULL
     WHERE id = $1 AND inbox_id = $2 AND processed_at IS NULL
       AND (locked_until IS NULL OR locked_until <= now() OR lock_token = $3)
     RETURNING ${EVENT_COLS}`,
    [eventId, inboxId, token],
  );
  return row;
}

// ---------- Bots ----------

export interface Bot {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  /** bigint: the `seq` of the last message the bot has read past. */
  cursor: string | bigint;
  inbox_ids: string[];
  lock_token: string | null;
  locked_until: Date | null;
  created_at: Date;
}

const BOT_COLS = `
  b.id, b.user_id, b.name, b.kind, b.cursor, b.lock_token, b.locked_until, b.created_at,
  COALESCE((SELECT jsonb_agg(bi.inbox_id ORDER BY bi.inbox_id) FROM loopway.bot_inboxes bi WHERE bi.bot_id = b.id),
           '[]'::jsonb) AS inbox_ids`;

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
  input: { userId: string; name: string; kind: string; inboxIds: string[] },
): Promise<Bot> {
  const id = uuidv7();
  await db.query(
    `WITH b AS (
       INSERT INTO loopway.bots (id, user_id, name, kind, cursor)
       VALUES ($1, $2, $3, $4, COALESCE((SELECT max(seq) FROM loopway.events WHERE inbox_id IN ${inboxIds("$5")}), 0))
       RETURNING id, user_id
     )
     INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, user_id)
     SELECT b.id, ids.value, b.user_id FROM b, ${inboxIds("$5")} AS ids(value)`,
    [id, input.userId, input.name, input.kind, input.inboxIds],
  );
  return (await getBot(db, id))!;
}

export async function listBots(db: Db, userId: string): Promise<Bot[]> {
  return db.query<Bot>(`SELECT ${BOT_COLS} FROM loopway.bots b WHERE b.user_id = $1 ORDER BY b.id`, [userId]);
}

export async function getBot(db: Db, id: string, userId?: string): Promise<Bot | undefined> {
  const [row] = userId
    ? await db.query<Bot>(`SELECT ${BOT_COLS} FROM loopway.bots b WHERE b.id = $1 AND b.user_id = $2`, [id, userId])
    : await db.query<Bot>(`SELECT ${BOT_COLS} FROM loopway.bots b WHERE b.id = $1`, [id]);
  return row;
}

/** `inboxIds`, when given, replaces the bot's inboxes. The cursor stays where it is. */
export async function updateBot(db: Db, bot: Bot, patch: { name?: string; inboxIds?: string[] }): Promise<Bot> {
  await db.query(
    `WITH b AS (UPDATE loopway.bots SET name = COALESCE($2, name) WHERE id = $1 RETURNING id),
     gone AS (
       DELETE FROM loopway.bot_inboxes
       WHERE bot_id = $1 AND $4::jsonb IS NOT NULL AND inbox_id NOT IN ${inboxIds("$4")}
     )
     INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, user_id)
     SELECT $1, ids.value, $3 FROM ${inboxIds("$4")} AS ids(value)
     ON CONFLICT DO NOTHING`,
    [bot.id, patch.name ?? null, bot.user_id, patch.inboxIds ?? null],
  );
  return (await getBot(db, bot.id))!;
}

export async function deleteBot(db: Db, id: string): Promise<void> {
  await db.query(`DELETE FROM loopway.bots WHERE id = $1`, [id]);
}

/** Take the lease if it's free or expired, or renew it with the token that holds it. */
export async function leaseBot(
  db: Db,
  id: string,
  ttlSeconds: number,
  currentToken: string | null,
): Promise<Bot | undefined> {
  const [row] = await db.query<{ id: string }>(
    `UPDATE loopway.bots SET
       lock_token   = CASE WHEN lock_token = $3 THEN lock_token ELSE $2 END,
       locked_until = now() + $4::int * interval '1 second'
     WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now() OR lock_token = $3)
     RETURNING id`,
    [id, newLockToken(), currentToken, ttlSeconds],
  );
  return row && getBot(db, row.id);
}

/** Moves the cursor forward, never back, for whoever holds a live lease. */
export async function advanceBotCursor(db: Db, id: string, seq: number, token: string): Promise<Bot | undefined> {
  const [row] = await db.query<{ id: string }>(
    `UPDATE loopway.bots SET cursor = GREATEST(cursor, $2::bigint)
     WHERE id = $1 AND lock_token = $3 AND locked_until > now()
     RETURNING id`,
    [id, seq, token],
  );
  return row && getBot(db, row.id);
}

/** Messages in the bot's inboxes after its cursor, oldest first, stopping at the first one still held back. */
export async function botMessages(db: Db, botId: string, limit: number): Promise<EventRow[]> {
  return db.query<EventRow>(
    `WITH mine AS (
       SELECT e.* FROM loopway.events e
       JOIN loopway.bot_inboxes bi ON bi.inbox_id = e.inbox_id
       JOIN loopway.bots b ON b.id = bi.bot_id
       WHERE b.id = $1 AND e.seq > b.cursor
     ),
     fresh AS (SELECT min(seq) AS seq FROM mine WHERE received_at > now() - $2::int * interval '1 second')
     SELECT ${EVENT_COLS} FROM mine
     WHERE (SELECT seq FROM fresh) IS NULL OR seq < (SELECT seq FROM fresh)
     ORDER BY seq LIMIT $3`,
    [botId, MESSAGE_HOLDBACK_SECONDS, limit],
  );
}
