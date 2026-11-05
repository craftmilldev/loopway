import type { CloudEvent } from "./cloudevents.js";
import { MIGRATE_LOCK, type Db } from "./db/index.js";
import type { SecretBox } from "./secrets.js";
import { slugProblem, type SlugProblem } from "./slugs.js";
import { newLoginCode, normalizeLoginCode, safeEqual, sha256, uuidv7 } from "./ids.js";

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

// ---------- Inboxes ----------

export interface Inbox {
  id: string;
  user_id: string;
  name: string;
  source_type: string;
  /** Everything but the webhook secret, which is in `secret_enc`. */
  config: unknown;
  /** The webhook secret, sealed by secrets.ts with the inbox id as context. Null for an inbox with none. */
  secret_enc: string | null;
  created_at: Date;
  /** When a sender last reached the inbox, whatever came of it. Null until it has. */
  last_delivery_at: Date | null;
  /** `accepted`, `ignored:<reason>` or `rejected:<status>`. */
  last_delivery_outcome: string | null;
}

/** Notes that a sender reached the inbox just now, with how it went. */
export async function recordDelivery(db: Db, id: string, outcome: string): Promise<void> {
  await db.query(`UPDATE loopway.inboxes SET last_delivery_at = now(), last_delivery_outcome = $2 WHERE id = $1`, [
    id,
    outcome,
  ]);
}

export async function createInbox(
  db: Db,
  input: {
    /** Given when `secretEnc` was sealed against it. */
    id?: string;
    userId: string;
    name: string;
    sourceType: string;
    config: unknown;
    secretEnc?: string | null;
  },
): Promise<Inbox> {
  const [row] = await db.query<Inbox>(
    `INSERT INTO loopway.inboxes (id, user_id, name, source_type, config, secret_enc)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
    [input.id ?? uuidv7(), input.userId, input.name, input.sourceType, input.config, input.secretEnc ?? null],
  );
  return row!;
}

/** The user's inboxes. */
export async function listInboxes(db: Db, userId: string): Promise<Inbox[]> {
  return db.query<Inbox>(`SELECT * FROM loopway.inboxes WHERE user_id = $1 ORDER BY id`, [userId]);
}

/** What taking a delivery reads of an inbox: its source and config to check it with, and what the metrics say. */
export type DeliveryInbox = Pick<
  Inbox,
  "id" | "user_id" | "source_type" | "config" | "secret_enc" | "created_at" | "last_delivery_at"
>;

/** The inbox a webhook names, as a delivery needs it. */
export async function deliveryInbox(db: Db, id: string): Promise<DeliveryInbox | undefined> {
  const [row] = await db.query<DeliveryInbox>(
    `SELECT id, user_id, source_type, config, secret_enc, created_at, last_delivery_at FROM loopway.inboxes WHERE id = $1`,
    [id],
  );
  return row;
}

/** The inbox, if it is the user's. */
export async function getInbox(db: Db, id: string, userId: string): Promise<Inbox | undefined> {
  const [row] = await db.query<Inbox>(`SELECT * FROM loopway.inboxes WHERE id = $1 AND user_id = $2`, [id, userId]);
  return row;
}

/** Every inbox of one source type, for the cron route: what it needs to fill them. */
export async function inboxesOfSource(
  db: Db,
  sourceType: string,
): Promise<Pick<Inbox, "id" | "user_id" | "source_type" | "config">[]> {
  return db.query(`SELECT id, user_id, source_type, config FROM loopway.inboxes WHERE source_type = $1 ORDER BY id`, [
    sourceType,
  ]);
}

/** Leaves `secretEnc` alone unless it is given. */
export async function updateInbox(
  db: Db,
  id: string,
  patch: { name?: string; config?: unknown; secretEnc?: string },
): Promise<Inbox> {
  const [row] = await db.query<Inbox>(
    `UPDATE loopway.inboxes SET
       name       = COALESCE($2, name),
       config     = COALESCE($3::jsonb, config),
       secret_enc = COALESCE($4, secret_enc)
     WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.config ?? null, patch.secretEnc ?? null],
  );
  return row!;
}

/** Recorded in schema_migrations once the plaintext secrets have been moved, so it is done once and never again. */
const SECRETS_MOVED = "029_inbox_secret_enc:data";

/**
 * The data half of migration 029, once: moves the secrets that are in plaintext in an inbox's config (from before
 * `secret_enc`) into it, sealed, and records that it is done, in one transaction under the migration lock. It runs
 * on a database that has the plaintext secrets and no other, never overwrites a `secret_enc`, and does nothing on
 * every run after the first. Returns how many it moved, or null if it had already run.
 */
export async function encryptInboxSecrets(db: Db, box: SecretBox): Promise<number | null> {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATE_LOCK]);
    const done = await tx.query(`SELECT 1 FROM loopway.schema_migrations WHERE version = $1`, [SECRETS_MOVED]);
    if (done.length) return null;
    const rows = await tx.query<{ id: string; secret: unknown }>(
      `SELECT id, config->'secret' AS secret FROM loopway.inboxes WHERE config ? 'secret'`,
    );
    for (const { id, secret } of rows) {
      // A null secret (Linear's "not set yet" kept as null) just goes away.
      await tx.query(
        `UPDATE loopway.inboxes SET config = config - 'secret', secret_enc = COALESCE(secret_enc, $2) WHERE id = $1`,
        [id, typeof secret === "string" && secret ? box.seal(secret, id) : null],
      );
    }
    await tx.query(`INSERT INTO loopway.schema_migrations (version) VALUES ($1)`, [SECRETS_MOVED]);
    return rows.length;
  });
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
  /** Made by the "send a test message" action rather than received from a sender. */
  is_test: boolean;
}

const MESSAGE_COLS = `id, inbox_id, seq, cloudevent, received_at, is_test`;

/** Returns the stored message and whether it was a redelivery of one we already had (same CE source+id). */
export async function insertMessage(db: Db, inboxId: string, ce: CloudEvent, test: boolean) {
  const [inserted] = await db.query<{ id: string; seq: string | bigint }>(
    `INSERT INTO loopway.messages (id, inbox_id, ce_id, ce_source, ce_type, ce_subject, ce_time, cloudevent, is_test)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT ON CONSTRAINT messages_ce_unique DO NOTHING
     RETURNING id, seq`,
    [uuidv7(), inboxId, ce.id, ce.source, ce.type, ce.subject ?? null, ce.time ?? null, ce, test],
  );
  if (inserted) return { id: inserted.id, seq: Number(inserted.seq), duplicate: false };
  const [existing] = await db.query<{ id: string; seq: string | bigint }>(
    `SELECT id, seq FROM loopway.messages WHERE inbox_id = $1 AND ce_source = $2 AND ce_id = $3`,
    [inboxId, ce.source, ce.id],
  );
  return { id: existing!.id, seq: Number(existing!.seq), duplicate: true };
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
