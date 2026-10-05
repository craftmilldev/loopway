import type { CloudEvent } from "./cloudevents.js";
import type { Db } from "./db/index.js";
import { newApiKey, newLockToken, newLoginCode, normalizeLoginCode, safeEqual, sha256, uuidv7 } from "./ids.js";

// ---------- Users ----------

export interface User {
  id: string;
  name: string;
  email: string | null;
  created_at: Date;
}

export async function createUser(db: Db, input: { name: string; email?: string | null }) {
  const apiKey = newApiKey();
  const [user] = await db.query<User>(
    `INSERT INTO loopway.users (id, name, email, api_key_hash) VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, created_at`,
    [uuidv7(), input.name, input.email ?? null, sha256(apiKey)],
  );
  return { user: user!, apiKey };
}

export async function findUserByApiKey(db: Db, apiKey: string): Promise<User | undefined> {
  const [user] = await db.query<User>(
    `SELECT id, name, email, created_at FROM loopway.users WHERE api_key_hash = $1`,
    [sha256(apiKey)],
  );
  return user;
}

export async function rotateApiKey(db: Db, userId: string): Promise<string> {
  const apiKey = newApiKey();
  await db.query(`UPDATE loopway.users SET api_key_hash = $2 WHERE id = $1`, [userId, sha256(apiKey)]);
  return apiKey;
}

export const LOGIN_CODE_TTL_MINUTES = 10;
const MAX_LOGIN_ATTEMPTS = 5;

/** Starts a login for the user with this email. Undefined if there is no such user. Replaces any earlier code. */
export async function createLoginCode(db: Db, email: string): Promise<{ user: User; code: string } | undefined> {
  const [user] = await db.query<User>(
    `SELECT id, name, email, created_at FROM loopway.users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (!user) return undefined;
  const code = newLoginCode();
  await db.query(`DELETE FROM loopway.login_codes WHERE user_id = $1`, [user.id]);
  await db.query(
    `INSERT INTO loopway.login_codes (id, user_id, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + $4::int * interval '1 minute')`,
    [uuidv7(), user.id, sha256(code), LOGIN_CODE_TTL_MINUTES],
  );
  return { user, code };
}

/**
 * Trades a valid, unexpired code for a new API key (which replaces the user's current one).
 * Codes are single-use and die after too many wrong guesses.
 */
export async function redeemLoginCode(
  db: Db,
  email: string,
  code: string,
): Promise<{ user: User; apiKey: string } | undefined> {
  const [row] = await db.query<{ id: string; code_hash: string; user_id: string }>(
    `UPDATE loopway.login_codes c SET attempts = attempts + 1
     FROM loopway.users u
     WHERE u.id = c.user_id AND lower(u.email) = lower($1) AND c.expires_at > now() AND c.attempts < $2
     RETURNING c.id, c.code_hash, c.user_id`,
    [email, MAX_LOGIN_ATTEMPTS],
  );
  if (!row || !safeEqual(row.code_hash, sha256(normalizeLoginCode(code)))) return undefined;
  const [used] = await db.query<{ id: string }>(`DELETE FROM loopway.login_codes WHERE id = $1 RETURNING id`, [row.id]);
  if (!used) return undefined;
  const apiKey = await rotateApiKey(db, row.user_id);
  const [user] = await db.query<User>(`SELECT id, name, email, created_at FROM loopway.users WHERE id = $1`, [row.user_id]);
  return { user: user!, apiKey };
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

export async function updateInbox(
  db: Db,
  id: string,
  patch: { name?: string; config?: unknown },
): Promise<Inbox> {
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
  status: EventStatus;
  cloudevent: CloudEvent;
  received_at: Date;
  lock_token: string | null;
  locked_until: Date | null;
  lock_count: number;
  processed_at: Date | null;
}

const EVENT_COLS = `
  id, inbox_id, cloudevent, received_at, lock_token, locked_until, lock_count, processed_at,
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
  const [row] = await db.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM loopway.events WHERE id = $1 AND inbox_id = $2`,
    [eventId, inboxId],
  );
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
