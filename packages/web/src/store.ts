import type { CloudEvent } from "./cloudevents.js";
import type { Db } from "./db/index.js";
import { slugProblem, type SlugProblem } from "./slugs.js";
import { API_TOKEN_PREFIX, newApiToken, newLoginCode, normalizeLoginCode, safeEqual, sha256, uuidv7 } from "./ids.js";

/** What a transaction body gets: just `query`, bound to the transaction's connection. */
type Q = Pick<Db, "query">;

// ---------- Users ----------

export interface User {
  id: string;
  name: string;
  email: string | null;
  /** Null only for accounts made before signup required one. */
  username: string | null;
  created_at: Date;
}

const USER_COLUMNS = `id, name, email, username, created_at`;

export async function createUser(db: Db, input: { name: string; email?: string | null }) {
  const [user] = await db.query<User>(
    `INSERT INTO loopway.users (id, name, email) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
    [uuidv7(), input.name, input.email ?? null],
  );
  return { user: user! };
}

/** Whether an account uses this email. */
export async function emailHasUser(db: Db, email: string): Promise<boolean> {
  const rows = await db.query(`SELECT 1 FROM loopway.users WHERE lower(email) = $1 LIMIT 1`, [
    email.trim().toLowerCase(),
  ]);
  return rows.length > 0;
}

/** Whether the user exists: all a request's auth needs of them. */
export async function userExists(db: Db, id: string): Promise<{ id: string } | undefined> {
  const [user] = await db.query<{ id: string }>(`SELECT id FROM loopway.users WHERE id = $1`, [id]);
  return user;
}

export async function findUserById(db: Db, id: string): Promise<User | undefined> {
  const [user] = await db.query<User>(`SELECT ${USER_COLUMNS} FROM loopway.users WHERE id = $1`, [id]);
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

/** Why a code could not be redeemed: it is wrong or expired, or the email is new and needs a username. */
type RedeemResult =
  | { ok: true; user: User; created: boolean }
  | { ok: false; problem: "invalid_code" | "username_required" | SlugProblem };

/**
 * Trades a valid, unexpired code for the user. An email with no user needs a `username`, and the user is named after it. If the username is
 * missing or unusable the code is left valid, with the guess refunded, so they can retry. Codes are single-use
 * and die after too many wrong guesses.
 */
export async function redeemLoginCode(db: Db, email: string, code: string, username?: string): Promise<RedeemResult> {
  const addr = email.toLowerCase();
  const [row] = await db.query<{ id: string; code_hash: string }>(
    `UPDATE loopway.login_codes SET attempts = attempts + 1
     WHERE email = $1 AND expires_at > now() AND attempts < $2
     RETURNING id, code_hash`,
    [addr, MAX_LOGIN_ATTEMPTS],
  );
  if (!row || !safeEqual(row.code_hash, sha256(normalizeLoginCode(code))))
    return { ok: false, problem: "invalid_code" };
  const refund = async (problem: "username_required" | SlugProblem) => {
    await db.query(`UPDATE loopway.login_codes SET attempts = attempts - 1 WHERE id = $1`, [row.id]);
    return { ok: false, problem } as const;
  };
  const [existing] = await db.query<User>(`SELECT ${USER_COLUMNS} FROM loopway.users WHERE lower(email) = $1`, [addr]);
  if (existing) {
    const [used] = await db.query<{ id: string }>(`DELETE FROM loopway.login_codes WHERE id = $1 RETURNING id`, [
      row.id,
    ]);
    if (!used) return { ok: false, problem: "invalid_code" };
    return { ok: true, user: existing, created: false };
  }
  if (!username) return refund("username_required");
  const problem = await usernameProblem(db, username);
  if (problem) return refund(problem);
  try {
    return await db.transaction(async (tx) => {
      const [used] = await tx.query<{ id: string }>(`DELETE FROM loopway.login_codes WHERE id = $1 RETURNING id`, [
        row.id,
      ]);
      if (!used) return { ok: false as const, problem: "invalid_code" as const };
      const [user] = await tx.query<User>(
        `INSERT INTO loopway.users (id, name, email, username) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
        [uuidv7(), username, addr, username],
      );
      return { ok: true as const, user: user!, created: true };
    });
  } catch (err) {
    // Someone claimed the username between the check and the insert (the transaction rolled back, code included).
    if ((err as { code?: string }).code === "23505") return refund("taken");
    throw err;
  }
}

// ---------- Usernames ----------

/** Undefined when `username` is free to use. `userId` is excluded from the "taken" check, so keeping your own name is fine. */
export async function usernameProblem(db: Q, username: string, userId?: string): Promise<SlugProblem | undefined> {
  const rule = slugProblem(username);
  if (rule) return rule;
  const [row] = await db.query(`SELECT 1 FROM loopway.users WHERE username = $1 AND id IS DISTINCT FROM $2::uuid`, [
    username,
    userId ?? null,
  ]);
  return row ? "taken" : undefined;
}

/** Sets the user's username. Returns the problem when it is invalid, reserved or taken; losing a race for it counts as taken. */
export async function setUsername(
  db: Db,
  userId: string,
  username: string,
): Promise<{ ok: true } | { ok: false; problem: SlugProblem }> {
  const problem = await usernameProblem(db, username, userId);
  if (problem) return { ok: false, problem };
  try {
    await db.query(`UPDATE loopway.users SET username = $1 WHERE id = $2`, [username, userId]);
    return { ok: true };
  } catch (err) {
    // 23505 is Postgres's unique_violation: someone claimed the name between the check and the write.
    if ((err as { code?: string }).code === "23505") return { ok: false, problem: "taken" };
    throw err;
  }
}

// ---------- API tokens ----------

export interface ApiToken {
  id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

const API_TOKEN_COLS = `id, name, created_at, last_used_at`;

/** Makes a token. This is the only time its value exists outside the caller's hands: only its hash is stored. */
export async function createApiToken(db: Db, userId: string, name: string) {
  const token = newApiToken();
  const [row] = await db.query<ApiToken>(
    `INSERT INTO loopway.api_tokens (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4) RETURNING ${API_TOKEN_COLS}`,
    [uuidv7(), userId, name, sha256(token)],
  );
  return { token, row: row! };
}

export const isApiToken = (token: string) => token.startsWith(API_TOKEN_PREFIX);

/** The user a live token belongs to. Notes its use at most once an hour, so a poller doesn't write on every read. */
export async function apiTokenUser(db: Db, token: string): Promise<{ id: string } | undefined> {
  const [row] = await db.query<{ id: string; token_id: string; stale: boolean }>(
    `SELECT user_id AS id, id AS token_id, (last_used_at IS NULL OR last_used_at < now() - interval '1 hour') AS stale
     FROM loopway.api_tokens WHERE token_hash = $1`,
    [sha256(token)],
  );
  if (!row) return undefined;
  if (row.stale) await db.query(`UPDATE loopway.api_tokens SET last_used_at = now() WHERE id = $1`, [row.token_id]);
  return { id: row.id };
}

export async function listApiTokens(db: Db, userId: string): Promise<ApiToken[]> {
  return db.query<ApiToken>(`SELECT ${API_TOKEN_COLS} FROM loopway.api_tokens WHERE user_id = $1 ORDER BY id`, [
    userId,
  ]);
}

export async function revokeApiToken(db: Db, userId: string, id: string): Promise<boolean> {
  const rows = await db.query(`DELETE FROM loopway.api_tokens WHERE id = $1 AND user_id = $2 RETURNING id`, [
    id,
    userId,
  ]);
  return rows.length > 0;
}

// ---------- Sources ----------

export interface Source {
  id: string;
  user_id: string;
  name: string;
  source_type: string;
  /** A source's own settings: only a schedule has any. */
  config: unknown;
  /** The webhook secret, sealed by secrets.ts with the source id as context. Null until one is registered. */
  secret_enc: string | null;
  created_at: Date;
  /** When a delivery last verified against this source. Null until one has. */
  last_delivery_at: Date | null;
  /** `accepted` or `ignored:<reason>`. */
  last_delivery_outcome: string | null;
}

/** Most sources one user can register: each one a delivery might be checked against costs a decrypt and an HMAC. */
export const MAX_SOURCES = 50;

/** Undefined when the user is already at MAX_SOURCES. The count and the insert are one statement. */
export async function createSource(
  db: Db,
  input: {
    /** Given because `secretEnc` is sealed against it. */
    id: string;
    userId: string;
    name: string;
    sourceType: string;
    config: unknown;
    secretEnc?: string | null;
  },
): Promise<Source | undefined> {
  const [row] = await db.query<Source>(
    `INSERT INTO loopway.sources (id, user_id, name, source_type, config, secret_enc)
     SELECT $1, $2, $3, $4, $5::jsonb, $6
     WHERE (SELECT count(*) FROM loopway.sources WHERE user_id = $2) < $7
     RETURNING *`,
    [input.id, input.userId, input.name, input.sourceType, input.config ?? {}, input.secretEnc ?? null, MAX_SOURCES],
  );
  return row;
}

export async function listSources(db: Db, userId: string): Promise<Source[]> {
  return db.query<Source>(`SELECT * FROM loopway.sources WHERE user_id = $1 ORDER BY id`, [userId]);
}

/** The source, if it is the user's. */
export async function getSource(db: Db, id: string, userId: string): Promise<Source | undefined> {
  const [row] = await db.query<Source>(`SELECT * FROM loopway.sources WHERE id = $1 AND user_id = $2`, [id, userId]);
  return row;
}

/** Every source of one type, for the cron route: what it needs to fill them. */
export async function sourcesOfType(
  db: Db,
  sourceType: string,
): Promise<Pick<Source, "id" | "user_id" | "source_type" | "config">[]> {
  return db.query(`SELECT id, user_id, source_type, config FROM loopway.sources WHERE source_type = $1 ORDER BY id`, [
    sourceType,
  ]);
}

/** Leaves anything not given alone. */
export async function updateSource(
  db: Db,
  id: string,
  patch: { name?: string; config?: unknown; secretEnc?: string },
): Promise<Source> {
  const [row] = await db.query<Source>(
    `UPDATE loopway.sources SET
       name       = COALESCE($2, name),
       config     = COALESCE($3::jsonb, config),
       secret_enc = COALESCE($4, secret_enc)
     WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.config ?? null, patch.secretEnc ?? null],
  );
  return row!;
}

export async function deleteSource(db: Db, id: string): Promise<void> {
  await db.query(`DELETE FROM loopway.sources WHERE id = $1`, [id]);
}

/** Notes that a delivery just verified against the source, with what came of it. */
export async function recordDelivery(db: Db, id: string, outcome: string): Promise<void> {
  await db.query(`UPDATE loopway.sources SET last_delivery_at = now(), last_delivery_outcome = $2 WHERE id = $1`, [
    id,
    outcome,
  ]);
}

// ---------- Messages ----------

/** How long a message is kept. The purge is daily, so reads apply this themselves and the cutoff is exact. */
export const RETENTION_DAYS = 14;
const RETAINED = `make_interval(days => ${RETENTION_DAYS})`;

/**
 * How far behind the clock a read stops. received_at is set inside the insert, but the row only becomes visible when
 * it commits. Without this a reader could read past a timestamp while an earlier one is still committing, and never
 * see that message, which would break at-least-once. It is the price of a timestamp cursor: delivery is this much late.
 */
export const READ_HOLDBACK_SECONDS = 5;

export interface MessageRow {
  id: string;
  user_id: string;
  source_id: string | null;
  cloudevent: CloudEvent;
  /** ISO 8601 with all six fractional digits: a JS Date would lose three. */
  received_at: string;
  /** Microseconds since the epoch, as a decimal string: what a cursor is. */
  received_us: string;
}

const MESSAGE_COLS = `id, user_id, source_id, cloudevent,
  to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at,
  (extract(epoch FROM received_at) * 1000000)::bigint::text AS received_us`;

/** A microsecond count as a timestamptz, exactly: `to_timestamp` goes through a float. */
const fromMicros = (param: string) => `('epoch'::timestamptz + ${param}::bigint * interval '1 microsecond')`;

/** Stores a message. A redelivery (same CE source and id) returns the one already stored. */
export async function insertMessage(db: Db, userId: string, sourceId: string | null, ce: CloudEvent) {
  const [inserted] = await db.query<{ id: string }>(
    `INSERT INTO loopway.messages (id, user_id, source_id, ce_id, ce_source, ce_type, ce_subject, ce_time, cloudevent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT ON CONSTRAINT messages_ce_unique DO NOTHING
     RETURNING id`,
    [uuidv7(), userId, sourceId, ce.id, ce.source, ce.type, ce.subject ?? null, ce.time ?? null, ce],
  );
  if (inserted) return { id: inserted.id, duplicate: false };
  const [existing] = await db.query<{ id: string }>(
    `SELECT id FROM loopway.messages WHERE user_id = $1 AND ce_source = $2 AND ce_id = $3`,
    [userId, ce.source, ce.id],
  );
  // The purge can take the row it conflicted with between the two statements: then it's new after all.
  if (!existing) return insertMessage(db, userId, sourceId, ce);
  return { id: existing.id, duplicate: true };
}

const typeFilter = (type: string, params: unknown[]) => {
  if (type.endsWith("*")) {
    params.push(type.slice(0, -1).replace(/[\\%_]/g, "\\$&") + "%");
    return `ce_type LIKE $${params.length}`;
  }
  params.push(type);
  return `ce_type = $${params.length}`;
};

export interface ReadPage {
  messages: MessageRow[];
  /** Pass these back as `since` and `after` to carry on. */
  nextSince: string;
  nextAfter: string | null;
  hasMore: boolean;
}

/**
 * The read: messages in `(received_at, id)` order, from `since` (microseconds, inclusive), up to the holdback.
 * `since: null` starts at the head, so nothing comes back and `nextSince` is where a new reader begins. `after` is a
 * message id at exactly `since`: it and anything before it in that microsecond are skipped, so a page boundary inside
 * one microsecond neither repeats nor loses a message, and a page of ties can't stop a reader making progress.
 */
export async function readMessages(
  db: Db,
  userId: string,
  opts: { since: string | null; after?: string; limit: number; type?: string },
): Promise<ReadPage> {
  const [row] = await db.query<{ head: string }>(
    `SELECT (extract(epoch FROM clock_timestamp() - make_interval(secs => ${READ_HOLDBACK_SECONDS})) * 1000000)::bigint::text AS head`,
  );
  const head = row!.head;
  if (opts.since === null) return { messages: [], nextSince: head, nextAfter: null, hasMore: false };
  const params: unknown[] = [userId, opts.since, head];
  const since = fromMicros("$2");
  const where = [
    `user_id = $1`,
    `received_at >= ${since}`,
    `received_at >= now() - ${RETAINED}`,
    `received_at < ${fromMicros("$3")}`,
  ];
  if (opts.after) {
    params.push(opts.after);
    where.push(`(received_at, id) > (${since}, $${params.length}::uuid)`);
  }
  if (opts.type) where.push(typeFilter(opts.type, params));
  params.push(opts.limit + 1);
  const rows = await db.query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM loopway.messages WHERE ${where.join(" AND ")}
     ORDER BY received_at, id LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const messages = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = messages.at(-1);
  if (hasMore) return { messages, nextSince: last!.received_us, nextAfter: last!.id, hasMore };
  // Read to the end, so the cursor can move up to the head: rows at the head itself weren't returned, and `since` is
  // inclusive, so they come next. A cursor set in the future stays where it is.
  const ahead = BigInt(opts.since) > BigInt(head);
  return { messages, nextSince: ahead ? opts.since : head, nextAfter: ahead ? (opts.after ?? null) : null, hasMore };
}

/** The newest messages, newest first, for looking at an inbox. Not for reading it: there's no cursor and no holdback. */
export async function latestMessages(db: Db, userId: string, opts: { limit: number; type?: string }) {
  const params: unknown[] = [userId];
  const where = [`user_id = $1`, `received_at >= now() - ${RETAINED}`];
  if (opts.type) where.push(typeFilter(opts.type, params));
  params.push(opts.limit);
  return db.query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM loopway.messages WHERE ${where.join(" AND ")}
     ORDER BY received_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
}

export async function getMessage(db: Db, userId: string, id: string): Promise<MessageRow | undefined> {
  const [row] = await db.query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM loopway.messages
     WHERE id = $1 AND user_id = $2 AND received_at >= now() - ${RETAINED}`,
    [id, userId],
  );
  return row;
}

export async function countMessages(db: Db, userId: string): Promise<number> {
  const [row] = await db.query<{ messages: number }>(
    `SELECT count(*)::int AS messages FROM loopway.messages WHERE user_id = $1 AND received_at >= now() - ${RETAINED}`,
    [userId],
  );
  return row!.messages;
}

/** Deletes what's past retention. Returns how many went. */
export async function purgeMessages(db: Db): Promise<number> {
  const rows = await db.query(`DELETE FROM loopway.messages WHERE received_at < now() - ${RETAINED} RETURNING 1`);
  return rows.length;
}
