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

export interface Bot {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  /** bigint: the `seq` of the last message the bot has read past. */
  cursor: string | bigint;
  inbox_ids: string[];
  /** The runner's lease: see leaseBot(). */
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
       VALUES ($1, $2, $3, $4, COALESCE((SELECT max(seq) FROM loopway.messages WHERE inbox_id IN ${inboxIds("$5")}), 0))
       RETURNING id, user_id
     )
     INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, user_id)
     SELECT b.id, ids.value, b.user_id FROM b, ${inboxIds("$5")} AS ids(value)`,
    [id, input.userId, input.name, input.kind, input.inboxIds],
  );
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
): Promise<Bot | undefined> {
  const [row] = await db.query<Bot>(
    `UPDATE loopway.bots b SET
       lock_token   = CASE WHEN b.lock_token = $3 THEN b.lock_token ELSE $2 END,
       locked_until = now() + $4::int * interval '1 second'
     WHERE b.id = $1 AND b.deleted_at IS NULL
       AND (b.locked_until IS NULL OR b.locked_until <= now() OR b.lock_token = $3)
     RETURNING ${BOT_COLS}`,
    [botId, newLockToken(), currentToken, ttlSeconds],
  );
  return row;
}

/** Drops the lease, if `token` is the one held. */
export async function releaseBot(db: Db, botId: string, token: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE loopway.bots SET lock_token = NULL, locked_until = NULL
     WHERE id = $1 AND deleted_at IS NULL AND lock_token = $2
     RETURNING id`,
    [botId, token],
  );
  return rows.length > 0;
}

/** Drops the lease whoever holds it, for a runner that died without releasing. */
export async function forceReleaseBot(db: Db, botId: string): Promise<void> {
  await db.query(
    `UPDATE loopway.bots SET lock_token = NULL, locked_until = NULL WHERE id = $1 AND deleted_at IS NULL`,
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

// ---------- Threads ----------

/** Enough about an assigned message to deliver it without fetching it again. */
export interface ThreadMessage {
  id: string;
  inbox_id: string;
  type: string;
  key: string | null;
}

export interface Thread {
  id: string;
  bot_id: string;
  status: "active" | "ended";
  started: boolean;
  interrupted: boolean;
  limited: boolean;
  keys: string[];
  /** Assigned, not handed to a run yet. */
  waiting: ThreadMessage[];
  /** Handed to a run that hasn't finished. */
  inflight: ThreadMessage[];
  delivered: number;
  /** Only from getThread(). */
  delivered_ids?: string[];
  created_at: Date;
  updated_at: Date;
}

export type ThreadMessageState = "waiting" | "inflight" | "delivered";

const threadMessages = (state: ThreadMessageState) => `
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'inbox_id', m.inbox_id, 'type', m.ce_type, 'key', tm.key)
                             ORDER BY tm.assigned_at, m.seq)
            FROM loopway.thread_messages tm JOIN loopway.messages m ON m.id = tm.message_id
            WHERE tm.thread_id = t.id AND tm.state = '${state}'), '[]'::jsonb)`;

const THREAD_COLS = `
  t.id, t.bot_id, t.status, t.started, t.interrupted, t.limited, t.created_at, t.updated_at,
  COALESCE((SELECT jsonb_agg(k.key ORDER BY k.key) FROM loopway.thread_keys k WHERE k.thread_id = t.id),
           '[]'::jsonb) AS keys,
  ${threadMessages("waiting")} AS waiting,
  ${threadMessages("inflight")} AS inflight,
  (SELECT count(*)::int FROM loopway.thread_messages tm WHERE tm.thread_id = t.id AND tm.state = 'delivered') AS delivered`;

const DELIVERED_IDS = `,
  COALESCE((SELECT jsonb_agg(tm.message_id ORDER BY tm.delivered_at, tm.assigned_at)
            FROM loopway.thread_messages tm WHERE tm.thread_id = t.id AND tm.state = 'delivered'),
           '[]'::jsonb) AS delivered_ids`;

/** The runner's live lease on bot $1 with token $2: the condition every thread write makes inside its own statement. */
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

/** The thread that holds each of these keys, for the bot's keys that are taken. */
export async function keyHolders(db: Db, botId: string, keys: string[]): Promise<Map<string, string>> {
  const rows = await db.query<{ key: string; thread_id: string }>(
    `SELECT key, thread_id FROM loopway.thread_keys WHERE bot_id = $1 AND key IN ${jsonStrings("$2")}`,
    [botId, keys],
  );
  return new Map(rows.map((r) => [r.key, r.thread_id]));
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

export interface Assignment {
  message_id: string;
  thread_id: string;
  add_keys?: string[];
  key?: string;
}

/**
 * One statement, so it's atomic: creates the threads the bot doesn't have yet, adds keys, inserts the messages as
 * waiting (one already assigned is skipped) and advances the cursor. Does nothing, and returns undefined, unless
 * `token` is the live lease. Callers check the ids, keys and messages first (threadBots and friends).
 */
export async function assignMessages(
  db: Db,
  botId: string,
  token: string,
  cursor: number,
  assignments: Assignment[],
): Promise<{ assigned: number } | undefined> {
  const [row] = await db.query<{ leased: number; assigned: number }>(
    `WITH bot AS (
       UPDATE loopway.bots b SET cursor = GREATEST(b.cursor, $3::bigint)
       WHERE ${LEASED} RETURNING b.id, b.user_id
     ),
     a AS (
       SELECT (x->>'message_id')::uuid AS message_id, (x->>'thread_id')::uuid AS thread_id,
              x->'add_keys' AS add_keys, x->>'key' AS key
       FROM jsonb_array_elements($4::jsonb) x
     ),
     new_threads AS (
       INSERT INTO loopway.threads (id, bot_id, user_id)
       SELECT DISTINCT a.thread_id, bot.id, bot.user_id FROM a, bot
       ON CONFLICT (id) DO NOTHING
     ),
     new_keys AS (
       INSERT INTO loopway.thread_keys (thread_id, bot_id, key)
       SELECT DISTINCT a.thread_id, bot.id, k.key
       FROM a CROSS JOIN bot CROSS JOIN LATERAL jsonb_array_elements_text(a.add_keys) AS k(key)
       ON CONFLICT DO NOTHING
     ),
     msgs AS (
       INSERT INTO loopway.thread_messages (thread_id, bot_id, message_id, state, key)
       SELECT DISTINCT ON (a.message_id) a.thread_id, bot.id, a.message_id, 'waiting', a.key FROM a, bot
       ON CONFLICT (bot_id, message_id) DO NOTHING RETURNING message_id
     )
     SELECT (SELECT count(*) FROM bot)::int AS leased, (SELECT count(*) FROM msgs)::int AS assigned`,
    [botId, token, cursor, assignments],
  );
  return row!.leased ? { assigned: row!.assigned } : undefined;
}

export interface ThreadPatch {
  status?: "active" | "ended";
  started?: boolean;
  interrupted?: boolean;
  limited?: boolean;
  addKeys?: string[];
}

/** False unless `token` is the live lease and the bot has this thread. */
export async function patchThread(
  db: Db,
  botId: string,
  token: string,
  id: string,
  patch: ThreadPatch,
): Promise<boolean> {
  const [row] = await db.query<{ n: number }>(
    `WITH bot AS (SELECT b.id FROM loopway.bots b WHERE ${LEASED}),
     upd AS (
       UPDATE loopway.threads t SET
         status      = COALESCE($4, t.status),
         started     = COALESCE($5::boolean, t.started),
         interrupted = COALESCE($6::boolean, t.interrupted),
         limited     = COALESCE($7::boolean, t.limited),
         updated_at  = now()
       FROM bot WHERE t.id = $3::uuid AND t.bot_id = bot.id RETURNING t.id, t.bot_id
     ),
     new_keys AS (
       INSERT INTO loopway.thread_keys (thread_id, bot_id, key)
       SELECT upd.id, upd.bot_id, k.value FROM upd, ${jsonStrings("$8")} AS k
       ON CONFLICT DO NOTHING
     )
     SELECT count(*)::int AS n FROM upd`,
    [
      botId,
      token,
      id,
      patch.status ?? null,
      patch.started ?? null,
      patch.interrupted ?? null,
      patch.limited ?? null,
      patch.addKeys ?? [],
    ],
  );
  return row!.n > 0;
}

/** Moves the thread's waiting messages to inflight and marks it active. Undefined unless `token` is the live lease. */
export async function deliverThread(
  db: Db,
  botId: string,
  token: string,
  id: string,
): Promise<ThreadMessage[] | undefined> {
  const [row] = await db.query<{ ok: number; messages: ThreadMessage[] }>(
    `WITH bot AS (SELECT b.id FROM loopway.bots b WHERE ${LEASED}),
     t AS (
       UPDATE loopway.threads t SET status = 'active', updated_at = now()
       FROM bot WHERE t.id = $3::uuid AND t.bot_id = bot.id RETURNING t.id
     ),
     moved AS (
       UPDATE loopway.thread_messages tm SET state = 'inflight'
       FROM t WHERE tm.thread_id = t.id AND tm.state = 'waiting'
       RETURNING tm.message_id, tm.key, tm.assigned_at
     )
     SELECT (SELECT count(*) FROM t)::int AS ok,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'inbox_id', m.inbox_id, 'type', m.ce_type, 'key', moved.key)
                                  ORDER BY moved.assigned_at, m.seq)
                 FROM moved JOIN loopway.messages m ON m.id = moved.message_id), '[]'::jsonb) AS messages`,
    [botId, token, id],
  );
  return row!.ok ? row!.messages : undefined;
}

/** Moves the thread's inflight messages to delivered, or back to waiting. Undefined unless `token` is the live lease. */
export async function finishThread(
  db: Db,
  botId: string,
  token: string,
  id: string,
  requeue: boolean,
): Promise<{ moved: number } | undefined> {
  const [row] = await db.query<{ ok: number; moved: number }>(
    `WITH bot AS (SELECT b.id FROM loopway.bots b WHERE ${LEASED}),
     t AS (
       UPDATE loopway.threads t SET updated_at = now()
       FROM bot WHERE t.id = $3::uuid AND t.bot_id = bot.id RETURNING t.id
     ),
     moved AS (
       UPDATE loopway.thread_messages tm SET
         state        = CASE WHEN $4::boolean THEN 'waiting' ELSE 'delivered' END,
         delivered_at = CASE WHEN $4::boolean THEN NULL ELSE now() END
       FROM t WHERE tm.thread_id = t.id AND tm.state = 'inflight' RETURNING tm.message_id
     )
     SELECT (SELECT count(*) FROM t)::int AS ok, (SELECT count(*) FROM moved)::int AS moved`,
    [botId, token, id, requeue],
  );
  return row!.ok ? { moved: row!.moved } : undefined;
}

export interface ImportedThread {
  id: string;
  keys: string[];
  status: "active" | "ended";
  started: boolean;
  interrupted: boolean;
  limited: boolean;
  messages: { id: string; state: ThreadMessageState; key?: string }[];
}

/**
 * Creates a thread with its keys and messages in one statement. Messages that don't exist (or aren't the user's)
 * are skipped, as are ones the bot already assigned to another thread. Returns how many were kept.
 */
export async function importThread(db: Db, bot: Bot, t: ImportedThread): Promise<{ messages: number }> {
  const [row] = await db.query<{ messages: number }>(
    `WITH t AS (
       INSERT INTO loopway.threads (id, bot_id, user_id, status, started, interrupted, limited)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::boolean, $6::boolean, $7::boolean) RETURNING id
     ),
     new_keys AS (
       INSERT INTO loopway.thread_keys (thread_id, bot_id, key)
       SELECT t.id, $2::uuid, k.value FROM t, ${jsonStrings("$8")} AS k
     ),
     msgs AS (
       INSERT INTO loopway.thread_messages (thread_id, bot_id, message_id, state, key, delivered_at)
       SELECT DISTINCT ON (m.id) t.id, $2::uuid, m.id, x.state, x.key, CASE WHEN x.state = 'delivered' THEN now() END
       FROM t, jsonb_to_recordset($9::jsonb) AS x(id uuid, state text, key text)
       JOIN loopway.messages m ON m.id = x.id
       JOIN loopway.inboxes i ON i.id = m.inbox_id AND i.user_id = $3::uuid
       ON CONFLICT (bot_id, message_id) DO NOTHING RETURNING message_id
     )
     SELECT (SELECT count(*) FROM msgs)::int AS messages`,
    [t.id, bot.id, bot.user_id, t.status, t.started, t.interrupted, t.limited, t.keys, t.messages],
  );
  return row!;
}
