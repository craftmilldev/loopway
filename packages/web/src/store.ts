import type { BotRule } from "@loopway/rules";
import { botActor, runnerActor, userActor } from "./actor.js";
import type { CloudEvent } from "./cloudevents.js";
import { MIGRATE_LOCK, type Db } from "./db/index.js";
import { ApiError } from "./http.js";
import type { SecretBox } from "./secrets.js";
import { slugProblem, type SlugProblem } from "./slugs.js";
import { newLockToken, newLoginCode, normalizeLoginCode, safeEqual, sha256, uuidv7 } from "./ids.js";

/** What a transaction body gets: just `query`, bound to the transaction's connection. */
type Q = Pick<Db, "query">;

// ---------- Users ----------

export interface User {
  id: string;
  name: string;
  email: string | null;
  /** The slug of their personal org. Null until a new signup has picked one. */
  username: string | null;
  created_at: Date;
}

const USER_COLUMNS = `u.id, u.name, u.email, u.created_at,
  (SELECT o.slug FROM loopway.orgs o WHERE o.personal_user_id = u.id) AS username`;

export async function createUser(db: Db, input: { name: string; email?: string | null }) {
  const [user] = await db.query<User>(
    `INSERT INTO loopway.users (id, name, email) VALUES ($1, $2, $3)
     RETURNING id, name, email, created_at, NULL::text AS username`,
    [uuidv7(), input.name, input.email ?? null],
  );
  return { user: user! };
}

export async function findUserById(db: Db, id: string): Promise<User | undefined> {
  const [user] = await db.query<User>(`SELECT ${USER_COLUMNS} FROM loopway.users u WHERE u.id = $1`, [id]);
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
  | { ok: true; user: User; created: boolean; joined: number }
  | { ok: false; problem: "invalid_code" | "username_required" | SlugProblem };

/**
 * Trades a valid, unexpired code for the user. An email with no user needs a `username`: the user, their personal
 * org and its membership are created together (the user is named after the username). If the username is
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
  const [existing] = await db.query<User>(`SELECT ${USER_COLUMNS} FROM loopway.users u WHERE lower(u.email) = $1`, [
    addr,
  ]);
  if (existing) {
    const [used] = await db.query<{ id: string }>(`DELETE FROM loopway.login_codes WHERE id = $1 RETURNING id`, [
      row.id,
    ]);
    if (!used) return { ok: false, problem: "invalid_code" };
    // Normally an invite for an existing user became a membership when it was added; this catches one that raced a signup.
    return { ok: true, user: existing, created: false, joined: await claimInvites(db, existing.id, addr) };
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
        `INSERT INTO loopway.users (id, name, email) VALUES ($1, $2, $3)
         RETURNING id, name, email, created_at, $4::text AS username`,
        [uuidv7(), username, addr, username],
      );
      await createPersonalOrg(tx, user!.id, username);
      return { ok: true as const, user: user!, created: true, joined: await claimInvites(tx, user!.id, addr) };
    });
  } catch (err) {
    // Someone claimed the slug between the check and the insert (the transaction rolled back, code included).
    if ((err as { code?: string }).code === "23505") return refund("taken");
    throw err;
  }
}

// ---------- Orgs and usernames ----------

export interface Org {
  id: string;
  slug: string;
  name: string;
  personal: boolean;
  /** The org has been shown the celebration for finishing setup. */
  celebrated: boolean;
}

/** Undefined when `username` is free to use. `userId` is excluded from the "taken" check, so keeping your own name is fine. */
export async function usernameProblem(db: Q, username: string, userId?: string): Promise<SlugProblem | undefined> {
  const rule = slugProblem(username);
  if (rule) return rule;
  const [row] = await db.query(
    `SELECT 1 FROM loopway.orgs WHERE slug = $1 AND personal_user_id IS DISTINCT FROM $2::uuid`,
    [username, userId ?? null],
  );
  return row ? "taken" : undefined;
}

/** A pending membership lapses this long after it was added; adding the email again starts a new one. */
const INVITE_TTL_DAYS = 7;
const LIVE_INVITE = `created_at > now() - make_interval(days => ${INVITE_TTL_DAYS})`;

/**
 * Turns the pending memberships for this email into real ones for the user (expired ones are just dropped).
 * Returns how many orgs they joined.
 */
async function claimInvites(tx: Q, userId: string, email: string): Promise<number> {
  const joined = await tx.query(
    `WITH claimed AS (DELETE FROM loopway.org_invites WHERE email = $2 RETURNING org_id, created_by, ${LIVE_INVITE} AS live)
     INSERT INTO loopway.org_members (org_id, user_id, created_by)
       SELECT c.org_id, $1, c.created_by FROM claimed c JOIN loopway.orgs o ON o.id = c.org_id
       WHERE c.live AND o.personal_user_id IS NULL
     ON CONFLICT DO NOTHING RETURNING org_id`,
    [userId, email],
  );
  return joined.length;
}

async function createPersonalOrg(tx: Q, userId: string, username: string) {
  const orgId = uuidv7();
  await tx.query(`INSERT INTO loopway.orgs (id, slug, name, personal_user_id) VALUES ($1, $2, $2, $3)`, [
    orgId,
    username,
    userId,
  ]);
  await tx.query(`INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, $3)`, [
    orgId,
    userId,
    userActor(userId),
  ]);
}

/**
 * Sets the user's username: the slug of their personal org, which is created (with them as its member) the first time.
 * Returns the problem when the name is invalid, reserved or taken; losing a race for it counts as taken.
 */
export async function setUsername(
  db: Db,
  userId: string,
  username: string,
): Promise<{ ok: true; created: boolean } | { ok: false; problem: SlugProblem }> {
  const problem = await usernameProblem(db, username, userId);
  if (problem) return { ok: false, problem };
  try {
    return await db.transaction(async (tx) => {
      const [renamed] = await tx.query(
        `UPDATE loopway.orgs SET slug = $1, name = $1 WHERE personal_user_id = $2 RETURNING id`,
        [username, userId],
      );
      if (renamed) return { ok: true as const, created: false };
      await createPersonalOrg(tx, userId, username);
      return { ok: true as const, created: true };
    });
  } catch (err) {
    // 23505 is Postgres's unique_violation. The check above and the write aren't atomic, so if someone else claimed
    // the slug in between, orgs.slug's unique constraint rejects ours and that is just "taken", not a 500.
    if ((err as { code?: string }).code === "23505") return { ok: false, problem: "taken" };
    throw err;
  }
}

export async function listOrgs(db: Q, userId: string): Promise<Org[]> {
  return db.query<Org>(
    `SELECT o.id, o.slug, o.name, (o.personal_user_id IS NOT NULL) AS personal,
       (o.celebrated_at IS NOT NULL) AS celebrated
     FROM loopway.orgs o JOIN loopway.org_members m ON m.org_id = o.id
     WHERE m.user_id = $1 ORDER BY personal DESC, o.slug`,
    [userId],
  );
}

/** Makes a shared org (named `name`, else its slug) with the user as its only member. Slugs follow the username rules. */
export async function createSharedOrg(
  db: Db,
  userId: string,
  slug: string,
  name?: string,
): Promise<{ ok: true; org: Org } | { ok: false; problem: SlugProblem }> {
  const problem = await usernameProblem(db, slug);
  if (problem) return { ok: false, problem };
  try {
    return await db.transaction(async (tx) => {
      const id = uuidv7();
      await tx.query(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, $2, $3)`, [id, slug, name || slug]);
      await tx.query(`INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, $3)`, [
        id,
        userId,
        userActor(userId),
      ]);
      return { ok: true as const, org: { id, slug, name: name || slug, personal: false, celebrated: false } };
    });
  } catch (err) {
    // Someone took the slug between the check and the insert.
    if ((err as { code?: string }).code === "23505") return { ok: false, problem: "taken" };
    throw err;
  }
}

/** Records that the org has been shown the celebration for finishing setup. Keeps the first time if called again. */
export async function markOrgCelebrated(db: Q, orgId: string): Promise<void> {
  await db.query(`UPDATE loopway.orgs SET celebrated_at = coalesce(celebrated_at, now()) WHERE id = $1`, [orgId]);
}

/** The org with this slug, if the user is a member of it. */
export async function memberOrg(db: Q, userId: string, slug: string): Promise<Org | undefined> {
  return (await listOrgs(db, userId)).find((o) => o.slug === slug);
}

// ---------- Inboxes ----------

export interface Inbox {
  id: string;
  /** Who made it, as an actor (see actor.ts). Informational: access runs on org_id. */
  created_by: string;
  org_id: string;
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
    orgId: string;
    name: string;
    sourceType: string;
    config: unknown;
    secretEnc?: string | null;
  },
): Promise<Inbox> {
  const [row] = await db.query<Inbox>(
    `INSERT INTO loopway.inboxes (id, created_by, org_id, name, source_type, config, secret_enc)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
    [
      input.id ?? uuidv7(),
      userActor(input.userId),
      input.orgId,
      input.name,
      input.sourceType,
      input.config,
      input.secretEnc ?? null,
    ],
  );
  return row!;
}

/** SQL for "`col` is the org of one the user (param `p`) belongs to": how access to any org-owned row is decided. */
const inOrgOf = (col: string, p: string) =>
  `${col} IN (SELECT m.org_id FROM loopway.org_members m WHERE m.user_id = ${p}::uuid)`;

/** The user's inboxes, or only those of `orgId` (an org the caller has checked the user is a member of). */
export async function listInboxes(db: Db, userId: string, orgId?: string): Promise<Inbox[]> {
  return db.query<Inbox>(
    `SELECT * FROM loopway.inboxes WHERE ${inOrgOf("org_id", "$1")} AND ($2::uuid IS NULL OR org_id = $2::uuid) ORDER BY id`,
    [userId, orgId ?? null],
  );
}

/** Without userId: for webhook ingestion. With userId: only if the user is a member of its org. */
export async function getInbox(db: Db, id: string, userId?: string): Promise<Inbox | undefined> {
  const [row] = userId
    ? await db.query<Inbox>(`SELECT * FROM loopway.inboxes WHERE id = $1 AND ${inOrgOf("org_id", "$2")}`, [id, userId])
    : await db.query<Inbox>(`SELECT * FROM loopway.inboxes WHERE id = $1`, [id]);
  return row;
}

/** Every inbox of one source type, for the cron route. */
export async function inboxesOfSource(db: Db, sourceType: string): Promise<Inbox[]> {
  return db.query<Inbox>(`SELECT * FROM loopway.inboxes WHERE source_type = $1 ORDER BY id`, [sourceType]);
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

export interface InboxActivity {
  inbox_id: string;
  /** One entry per UTC day of the window, oldest first, zero for a day with no messages. */
  days: { date: string; received: number }[];
  /** Messages received in the window. */
  received: number;
  /** Messages ever received, not only in the window. */
  messages: number;
  /** The newest message ever, not only in the window. */
  last_message_at: Date | null;
}

/** What the user's inboxes received in the last `days` UTC days (today included), for one inbox or all. */
export async function inboxActivity(
  db: Db,
  userId: string,
  days: number,
  inboxId?: string,
  orgId?: string,
): Promise<InboxActivity[]> {
  const dates = windowDates(days);
  const since = dates[0] + "T00:00:00Z";
  const scope = `${inOrgOf("i.org_id", "$1")} AND ($2::uuid IS NULL OR i.id = $2::uuid) AND ($3::uuid IS NULL OR i.org_id = $3::uuid)`;
  const [inboxes, perDay, totals] = await Promise.all([
    db.query<{ id: string }>(`SELECT i.id FROM loopway.inboxes i WHERE ${scope} ORDER BY i.id`, [
      userId,
      inboxId ?? null,
      orgId ?? null,
    ]),
    db.query<{ inbox_id: string; day: string; n: number }>(
      `SELECT m.inbox_id, to_char(m.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
       FROM loopway.messages m JOIN loopway.inboxes i ON i.id = m.inbox_id
       WHERE ${scope} AND m.received_at >= $4::timestamptz
       GROUP BY 1, 2`,
      [userId, inboxId ?? null, orgId ?? null, since],
    ),
    db.query<{ inbox_id: string; messages: number; last: Date }>(
      `SELECT m.inbox_id, count(*)::int AS messages, max(m.received_at) AS last
       FROM loopway.messages m JOIN loopway.inboxes i ON i.id = m.inbox_id
       WHERE ${scope}
       GROUP BY 1`,
      [userId, inboxId ?? null, orgId ?? null],
    ),
  ]);
  return inboxes.map(({ id }) => {
    const counts = new Map(perDay.filter((r) => r.inbox_id === id).map((r) => [r.day, r.n]));
    const t = totals.find((r) => r.inbox_id === id);
    const list = dates.map((date) => ({ date, received: counts.get(date) ?? 0 }));
    return {
      inbox_id: id,
      days: list,
      received: list.reduce((n, d) => n + d.received, 0),
      messages: t?.messages ?? 0,
      last_message_at: t?.last ?? null,
    };
  });
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
  /** Who made it, as an actor (see actor.ts). Informational: access runs on org_id. */
  created_by: string;
  org_id: string;
  name: string;
  /** The model its sessions run on, as its harness takes it. */
  model: string;
  /** The coding-agent CLI its sessions run in: `claude`, `cursor`, `codex`, `hermes` or `script`. */
  harness: string;
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
  b.id, b.created_by, b.org_id, b.name, b.model, b.harness, b.cursor, b.lock_token, b.locked_until, b.runner_id, b.created_at,
  COALESCE((SELECT jsonb_agg(bi.inbox_id ORDER BY bi.inbox_id) FROM loopway.bot_inboxes bi WHERE bi.bot_id = b.id),
           '[]'::jsonb) AS inbox_ids,
  (SELECT jsonb_build_object('version', v.version, 'prompt', v.prompt, 'rules', v.rules, 'created_at', v.created_at)
   FROM loopway.bot_versions v WHERE v.bot_id = b.id ORDER BY v.version DESC LIMIT 1) AS prompt_version`;

/**
 * Messages that commit out of seq order (two webhooks landing at once) would be skipped by a cursor that had
 * passed them, so bots don't read anything received this recently, nor anything after it.
 */
const MESSAGE_HOLDBACK_SECONDS = 5;

// Inbox ids go in as a jsonb array, which both drivers serialize the same way.
const inboxIds = (param: string) => `(SELECT value::uuid FROM jsonb_array_elements_text(${param}::jsonb))`;

/**
 * The org must be one the user belongs to, and so must the inboxes, which share the bot's org (the caller checks;
 * bot_inboxes' keys enforce it too). The cursor starts at their newest message. */
export async function createBot(
  db: Db,
  input: {
    userId: string;
    orgId: string;
    name: string;
    model: string;
    harness: string;
    inboxIds: string[];
    prompt?: string;
    rules?: BotRule[];
  },
): Promise<Bot> {
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO loopway.bots (id, created_by, org_id, name, model, harness, cursor)
       VALUES ($1, $2, $6::uuid,
         $3, $5, $7, COALESCE((SELECT max(seq) FROM loopway.messages WHERE inbox_id IN ${inboxIds("$4")}), 0))`,
      [id, userActor(input.userId), input.name, input.inboxIds, input.model, input.orgId, input.harness],
    );
    await tx.query(
      `INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, org_id)
       SELECT $1, ids.value, (SELECT org_id FROM loopway.bots WHERE id = $1)
       FROM ${inboxIds("$2")} AS ids(value)`,
      [id, input.inboxIds],
    );
    if (input.prompt !== undefined) await addBotVersion(tx, id, input.prompt, input.rules);
  });
  return (await getBot(db, id))!;
}

// Deleted bots keep their row (deleted_at is set), and nothing reads them.

/** The user's bots, or only those of `orgId` (an org the caller has checked the user is a member of). */
export async function listBots(db: Db, userId: string, orgId?: string): Promise<Bot[]> {
  return db.query<Bot>(
    `SELECT ${BOT_COLS} FROM loopway.bots b
     WHERE ${inOrgOf("b.org_id", "$1")} AND ($2::uuid IS NULL OR b.org_id = $2::uuid) AND b.deleted_at IS NULL ORDER BY b.id`,
    [userId, orgId ?? null],
  );
}

export async function getBot(db: Db, id: string, userId?: string): Promise<Bot | undefined> {
  const [row] = userId
    ? await db.query<Bot>(
        `SELECT ${BOT_COLS} FROM loopway.bots b WHERE b.id = $1 AND ${inOrgOf("b.org_id", "$2")} AND b.deleted_at IS NULL`,
        [id, userId],
      )
    : await db.query<Bot>(`SELECT ${BOT_COLS} FROM loopway.bots b WHERE b.id = $1 AND b.deleted_at IS NULL`, [id]);
  return row;
}

/** The last `days` UTC dates, today included, oldest first. */
function windowDates(days: number): string[] {
  const today = new Date().toISOString().slice(0, 10);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    return d.toISOString().slice(0, 10);
  });
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
  /** How many of the bot's threads are at each automation level; a thread with none set counts as 2. */
  levels: { 2: number; 3: number; 4: number };
}

/**
 * What the user's bots delivered in the last `days` UTC days (today included), for one bot or all. A run is the
 * messages of one thread delivered at the same instant.
 */
export async function botActivity(
  db: Db,
  userId: string,
  days: number,
  botId?: string,
  orgId?: string,
): Promise<BotActivity[]> {
  const dates = windowDates(days);
  const since = dates[0] + "T00:00:00Z";
  const scope = `${inOrgOf("b.org_id", "$1")} AND b.deleted_at IS NULL AND ($2::uuid IS NULL OR b.id = $2::uuid) AND ($3::uuid IS NULL OR b.org_id = $3::uuid)`;
  const [bots, perDay, totals, levelRows] = await Promise.all([
    db.query<{ id: string }>(`SELECT b.id FROM loopway.bots b WHERE ${scope} ORDER BY b.id`, [
      userId,
      botId ?? null,
      orgId ?? null,
    ]),
    db.query<{ bot_id: string; day: string; n: number }>(
      `SELECT tm.bot_id, to_char(tm.delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
       FROM loopway.thread_messages tm JOIN loopway.bots b ON b.id = tm.bot_id
       WHERE ${scope} AND tm.delivered_at >= $4::timestamptz
       GROUP BY 1, 2`,
      [userId, botId ?? null, orgId ?? null, since],
    ),
    db.query<{ bot_id: string; last: Date | null; runs: number | null; median: number | null }>(
      `SELECT b.id AS bot_id,
              (SELECT max(tm.delivered_at) FROM loopway.thread_messages tm WHERE tm.bot_id = b.id) AS last,
              w.runs, w.median
       FROM loopway.bots b
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT (tm.thread_id, tm.delivered_at))::int AS runs,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM tm.delivered_at - tm.assigned_at)))::float8 AS median
         FROM loopway.thread_messages tm WHERE tm.bot_id = b.id AND tm.delivered_at >= $4::timestamptz
       ) w ON true
       WHERE ${scope}`,
      [userId, botId ?? null, orgId ?? null, since],
    ),
    db.query<{ bot_id: string; level: 2 | 3 | 4; n: number }>(
      `SELECT t.bot_id, coalesce(t.automation_level, 2)::int AS level, count(*)::int AS n
       FROM loopway.threads t JOIN loopway.bots b ON b.id = t.bot_id
       WHERE ${scope}
       GROUP BY 1, 2`,
      [userId, botId ?? null, orgId ?? null],
    ),
  ]);
  return bots.map(({ id }) => {
    const levels = { 2: 0, 3: 0, 4: 0 };
    for (const r of levelRows) if (r.bot_id === id) levels[r.level] = r.n;
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
      levels,
    };
  });
}

/** `inboxIds`, when given, replaces the bot's inboxes. The cursor stays where it is. */
export async function updateBot(
  db: Db,
  bot: Bot,
  patch: { name?: string; model?: string; harness?: string; inboxIds?: string[] },
): Promise<Bot> {
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE loopway.bots SET name = COALESCE($2, name), model = COALESCE($3, model), harness = COALESCE($4, harness) WHERE id = $1`,
      [bot.id, patch.name ?? null, patch.model ?? null, patch.harness ?? null],
    );
    if (patch.inboxIds) {
      await tx.query(`DELETE FROM loopway.bot_inboxes WHERE bot_id = $1 AND inbox_id NOT IN ${inboxIds("$2")}`, [
        bot.id,
        patch.inboxIds,
      ]);
      await tx.query(
        `INSERT INTO loopway.bot_inboxes (bot_id, inbox_id, org_id)
         SELECT $1, ids.value, $3 FROM ${inboxIds("$2")} AS ids(value)
         ON CONFLICT DO NOTHING`,
        [bot.id, patch.inboxIds, bot.org_id],
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
  /** Who registered it, as an actor (see actor.ts). Informational: access runs on org_id. */
  created_by: string;
  org_id: string;
  /** The slug of its org. */
  org_slug: string;
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
  r.id, r.created_by, r.org_id, (SELECT o.slug FROM loopway.orgs o WHERE o.id = r.org_id) AS org_slug,
  r.name, r.lock_token, r.locked_until, r.created_at, r.last_seen_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) ORDER BY b.id) FROM loopway.bots b
            WHERE b.runner_id = r.id AND b.deleted_at IS NULL AND b.locked_until > now()), '[]'::jsonb) AS bots,
  (SELECT count(*)::int FROM loopway.threads t WHERE t.runner_id = r.id) AS threads`;

/**
 * Registers the runner in the org, or renames it and notes it was seen. A runner keeps its org: undefined if the id
 * is already in use by a runner of another org (or one the user can't see). `firstSeconds` is set when this call made
 * the org's first runner: the seconds since the org was created.
 */
export async function upsertRunner(
  db: Db,
  userId: string,
  orgId: string,
  id: string,
  name: string,
): Promise<(Runner & { firstSeconds?: number }) | undefined> {
  const rows = await db.query<{ id: string; inserted: boolean }>(
    `INSERT INTO loopway.runners (id, created_by, org_id, name) VALUES ($1, $5, $4, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, last_seen_at = now()
     WHERE loopway.runners.org_id = EXCLUDED.org_id AND ${inOrgOf("loopway.runners.org_id", "$2")}
     RETURNING id, (xmax = 0) AS inserted`,
    [id, userId, name, orgId, userActor(userId)],
  );
  if (!rows.length) return undefined;
  const runner = (await getRunner(db, userId, id))!;
  if (!rows[0]!.inserted) return runner;
  const [first] = await db.query<{ seconds: number | null }>(
    `SELECT CASE WHEN (SELECT count(*) FROM loopway.runners WHERE org_id = o.id) = 1
                 THEN extract(epoch FROM now() - o.created_at)::float8 END AS seconds
     FROM loopway.orgs o WHERE o.id = $1`,
    [orgId],
  );
  return { ...runner, firstSeconds: first?.seconds ?? undefined };
}

export async function getRunner(db: Db, userId: string, id: string): Promise<Runner | undefined> {
  const [row] = await db.query<Runner>(
    `SELECT ${RUNNER_COLS} FROM loopway.runners r WHERE r.id = $1 AND ${inOrgOf("r.org_id", "$2")}`,
    [id, userId],
  );
  return row;
}

export async function listRunners(db: Db, userId: string, orgId?: string): Promise<Runner[]> {
  return db.query<Runner>(
    `SELECT ${RUNNER_COLS} FROM loopway.runners r
     WHERE ${inOrgOf("r.org_id", "$1")} AND ($2::uuid IS NULL OR r.org_id = $2::uuid) ORDER BY r.created_at, r.id`,
    [userId, orgId ?? null],
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
     WHERE r.id = $1 AND ${inOrgOf("r.org_id", "$2")}
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
     WHERE id = $1 AND ${inOrgOf("org_id", "$2")} AND ($3::text IS NULL OR lock_token = $3)
     RETURNING id`,
    [id, userId, token],
  );
  return rows.length > 0;
}

/** The runner whose live lease has this token. */
export async function runnerByToken(db: Db, userId: string, token: string): Promise<Runner | undefined> {
  const [row] = await db.query<Runner>(
    `SELECT ${RUNNER_COLS} FROM loopway.runners r WHERE ${inOrgOf("r.org_id", "$1")} AND r.lock_token = $2 AND r.locked_until > now()`,
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
  /** Null for a manager thread, which belongs to the org. */
  bot_id: string | null;
  /** 'bot': a bot's session. 'manager': a chat with the org's manager (no bot). */
  kind: "bot" | "manager";
  /** The runner that assigned it for the bot, as an actor (see actor.ts); the bot if its lease named no runner. Informational. */
  created_by: string;
  status: "active" | "ended";
  started: boolean;
  interrupted: boolean;
  limited: boolean;
  /** The runner that owns the thread (see claimThread): its session lives there. Null until a runner claims it. */
  runner_id: string | null;
  /** 2: a person started it. 3: a bot did, but a person took part. 4: no person did. Null while no message has a known author. */
  automation_level: 2 | 3 | 4 | null;
  /** What the thread's session recorded about itself: a JSON object. */
  metadata: Record<string, unknown>;
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

type ThreadMessageState = "waiting" | "inflight" | "delivered";

const threadMessages = (state: ThreadMessageState) => `
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'inbox_id', m.inbox_id, 'type', m.ce_type, 'subject', tm.subject)
                             ORDER BY tm.assigned_at, m.seq)
            FROM loopway.thread_messages tm JOIN loopway.messages m ON m.id = tm.message_id
            WHERE tm.thread_id = t.id AND tm.state = '${state}'), '[]'::jsonb)`;

const THREAD_COLS = `
  t.id, t.bot_id, t.kind, t.created_by, t.status, t.started, t.interrupted, t.limited, t.runner_id, t.automation_level, t.metadata,
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

/**
 * The bot's threads by status. `pending` is the threads a runner has work on: the active ones, and any ended one that
 * still has a message waiting or in flight. A bot's ended threads pile up, so the runner's polls ask for these.
 */
export async function listThreads(
  db: Db,
  botId: string,
  status: "active" | "ended" | "all" | "pending",
): Promise<Thread[]> {
  return db.query<Thread>(
    `SELECT ${THREAD_COLS} FROM loopway.threads t
     WHERE t.bot_id = $1 AND (
       $2 = 'all' OR t.status = $2
       OR ($2 = 'pending' AND (t.status = 'active' OR EXISTS (
         SELECT 1 FROM loopway.thread_messages tm WHERE tm.thread_id = t.id AND tm.state <> 'delivered'))))
     ORDER BY t.created_at, t.id`,
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

/** The org's threads of one kind, oldest first. A manager thread has no bot, so no bot's list ever has it. */
export async function listOrgThreads(db: Db, orgId: string, kind: "bot" | "manager"): Promise<Thread[]> {
  return db.query<Thread>(
    `SELECT ${THREAD_COLS} FROM loopway.threads t WHERE t.org_id = $1 AND t.kind = $2 ORDER BY t.created_at, t.id`,
    [orgId, kind],
  );
}

export async function getOrgThread(db: Db, orgId: string, id: string): Promise<Thread | undefined> {
  const [row] = await db.query<Thread>(
    `SELECT ${THREAD_COLS}${DELIVERED_IDS} FROM loopway.threads t WHERE t.id = $1 AND t.org_id = $2 AND t.kind = 'manager'`,
    [id, orgId],
  );
  return row;
}

/** Which bot has each of these threads, for the ones that exist. */
export async function threadBots(db: Db, ids: string[]): Promise<Map<string, string>> {
  const rows = await db.query<{ id: string; bot_id: string }>(
    `SELECT id, bot_id FROM loopway.threads WHERE bot_id IS NOT NULL AND id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`,
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

/**
 * Each thread's newest `limit` messages (any state), newest first (by id, which is time-ordered, so an index on
 * thread_messages(thread_id, message_id) reads just those rows), for finding the thread's title. */
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
       WHERE tm.thread_id = t.id ORDER BY tm.message_id DESC LIMIT $2
     ) n
     WHERE t.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))
     ORDER BY t.id, n.id DESC`,
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
     WHERE t.id = $4::uuid AND t.bot_id = $1::uuid AND ${inOrgOf("r.org_id", "$2")} AND t.org_id = r.org_id
       AND r.lock_token = $3 AND r.locked_until > now() AND (t.runner_id IS NULL OR t.runner_id = r.id)
     RETURNING t.id`,
    [botId, userId, token, id],
  );
  return rows.length ? getThread(db, botId, id) : undefined;
}

/**
 * Makes a manager thread of the org, owned by the runner holding the live lease `token`. Undefined if the id is taken
 * or the token isn't a live lease of a runner of the org.
 */
export async function createManagerThread(
  db: Db,
  orgId: string,
  id: string,
  token: string,
): Promise<Thread | undefined> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO loopway.threads (id, bot_id, kind, created_by, org_id, runner_id, started, automation_level)
     SELECT $1::uuid, NULL, 'manager', 'runner:' || r.id, r.org_id, r.id, true, 2
     FROM loopway.runners r WHERE r.org_id = $2::uuid AND r.lock_token = $3 AND r.locked_until > now()
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id, orgId, token],
  );
  return rows.length ? getOrgThread(db, orgId, id) : undefined;
}

export interface ManagerThreadPatch {
  status?: "active" | "ended";
  metadataSet?: Record<string, unknown>;
  metadataUnset?: string[];
}

/** False unless `token` is the live lease of the runner that owns the org's manager thread. */
export async function patchManagerThread(
  db: Db,
  orgId: string,
  token: string,
  id: string,
  patch: ManagerThreadPatch,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const upd = await tx.query<{ metadata_bytes: number }>(
      `UPDATE loopway.threads t SET
         status     = COALESCE($4::text, t.status),
         metadata   = (t.metadata || $5::jsonb) - $6::text[],
         updated_at = now()
       WHERE t.id = $3::uuid AND t.org_id = $1::uuid AND t.kind = 'manager' AND EXISTS (
         SELECT 1 FROM loopway.runners r
         WHERE r.id = t.runner_id AND r.lock_token = $2 AND r.locked_until > now())
       RETURNING octet_length(t.metadata::text) AS metadata_bytes`,
      [orgId, token, id, patch.status ?? null, patch.metadataSet ?? {}, patch.metadataUnset ?? []],
    );
    if (!upd.length) return false;
    // Throwing rolls the update back.
    if (upd[0]!.metadata_bytes > METADATA_MAX_BYTES)
      throw new ApiError(400, "metadata_too_large", `A thread's metadata can be at most ${METADATA_MAX_BYTES} bytes`);
    return true;
  });
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
    const ended = await tx.query<{ org_id: string }>(
      `UPDATE loopway.threads SET status = 'ended', updated_at = now()
       WHERE id = $2::uuid AND bot_id = $1::uuid AND status <> 'ended' RETURNING org_id`,
      [botId, id],
    );
    if (ended.length) await recordThreadEvents(tx, ended[0]!.org_id, botId, id, ["ended"]);
  });
}

type ThreadEventKind = "created" | "started" | "ended" | "interrupted" | "limited" | "limit_cleared";

/** Writes one event per kind, for a thread's transitions. */
async function recordThreadEvents(
  db: Pick<Db, "query">,
  orgId: string,
  botId: string,
  threadId: string,
  kinds: ThreadEventKind[],
) {
  await db.query(
    `INSERT INTO loopway.thread_events (org_id, bot_id, thread_id, kind)
     SELECT $1::uuid, $2::uuid, $3::uuid, k.value FROM jsonb_array_elements_text($4::jsonb) WITH ORDINALITY k(value, n)
     ORDER BY k.n`,
    [orgId, botId, threadId, kinds],
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
export async function listThreadEvents(
  db: Db,
  userId: string,
  limit: number,
  before?: string,
  orgId?: string,
): Promise<ThreadEvent[]> {
  return db.query<ThreadEvent>(
    `SELECT e.id::text, e.kind, e.at, e.bot_id, b.name AS bot_name, e.thread_id,
            COALESCE((SELECT jsonb_agg(k.subject ORDER BY k.subject) FROM loopway.thread_subjects k
                      WHERE k.thread_id = e.thread_id), '[]'::jsonb) AS subjects
     FROM loopway.thread_events e JOIN loopway.bots b ON b.id = e.bot_id
     WHERE ${inOrgOf("e.org_id", "$1")} AND b.deleted_at IS NULL AND ($4::uuid IS NULL OR e.org_id = $4::uuid)
       AND ($3::bigint IS NULL
            OR (e.at, e.id) < (SELECT p.at, p.id FROM loopway.thread_events p
                                WHERE p.id = $3::bigint AND ${inOrgOf("p.org_id", "$1")}))
     ORDER BY e.at DESC, e.id DESC LIMIT $2`,
    [userId, limit, before ?? null, orgId ?? null],
  );
}

export interface Assignment {
  message_id: string;
  thread_id: string;
  add_subjects?: string[];
  subject?: string;
  /** Who made the message, as the bot's rules judged it (see `authorKind` in BotRule). Drives the thread's level. */
  author_kind?: "human" | "bot";
  /** The runner a new thread is created on (it owns the thread from the start); ignored for a thread that exists. */
  runner_id?: string;
}

/**
 * One transaction, so it's atomic: creates the threads the bot doesn't have yet, adds subjects, inserts the messages as
 * waiting (one already assigned is skipped), sets the threads' automation levels from the messages' author kinds
 * (`levels` lists each one set or changed) and advances the cursor. Does nothing, and returns undefined, unless `token`
 * is the live lease. Callers check the ids, subjects and messages first (threadBots and friends).
 */
export async function assignMessages(
  db: Db,
  botId: string,
  token: string,
  cursor: number,
  assignments: Assignment[],
): Promise<{ assigned: number; levels: (2 | 3 | 4)[]; onRunner: number } | undefined> {
  return db.transaction(async (tx) => {
    const [bot] = await tx.query<{ org_id: string; runner_id: string | null }>(
      `UPDATE loopway.bots b SET cursor = GREATEST(b.cursor, $3::bigint)
       WHERE ${LEASED} RETURNING b.org_id, b.runner_id`,
      [botId, token, cursor],
    );
    if (!bot) return undefined;
    // The assignments as rows, shared by the three inserts below.
    const a = `(SELECT (x->>'message_id')::uuid AS message_id, (x->>'thread_id')::uuid AS thread_id,
                       x->'add_subjects' AS add_subjects, x->>'subject' AS subject, x->>'author_kind' AS author_kind, (x->>'runner_id')::uuid AS runner_id, n
                FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS e(x, n))`;
    // A new thread's level comes from its first message's author kind: a person is 2, a bot 4.
    const created = await tx.query<{ id: string; level: 2 | 4 | null; runner_id: string | null }>(
      `INSERT INTO loopway.threads (id, bot_id, created_by, org_id, automation_level, runner_id)
       SELECT DISTINCT ON (a.thread_id) a.thread_id, $2::uuid, $3, $4::uuid,
              CASE a.author_kind WHEN 'human' THEN 2 WHEN 'bot' THEN 4 END, r.id
       FROM ${a} a LEFT JOIN loopway.runners r ON r.id = a.runner_id AND r.org_id = $4::uuid
       ORDER BY a.thread_id, a.n
       ON CONFLICT (id) DO NOTHING RETURNING id, automation_level AS level, runner_id`,
      [assignments, botId, bot.runner_id ? runnerActor(bot.runner_id) : botActor(botId), bot.org_id],
    );
    for (const t of created) await recordThreadEvents(tx, bot.org_id, botId, t.id, ["created"]);
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
    // A person's message moves a bot's thread from 4 to 3. 2 and 3 stay.
    const joined = await tx.query(
      `UPDATE loopway.threads SET automation_level = 3, updated_at = now()
       WHERE automation_level = 4 AND id IN (SELECT a.thread_id FROM ${a} a WHERE a.author_kind = 'human')
       RETURNING id`,
      [assignments],
    );
    const levels = [...created.map((t) => t.level), ...joined.map(() => 3 as const)];
    return {
      assigned: msgs.length,
      levels: levels.filter((l) => l !== null),
      onRunner: created.filter((t) => t.runner_id).length,
    };
  });
}

export interface ThreadPatch {
  status?: "active" | "ended";
  started?: boolean;
  interrupted?: boolean;
  limited?: boolean;
  addSubjects?: string[];
  /** Keys to set (merged into the metadata) and keys to remove; the set is applied first. */
  metadataSet?: Record<string, unknown>;
  metadataUnset?: string[];
}

/** The most a thread's metadata may be, serialized. */
export const METADATA_MAX_BYTES = 16 * 1024;

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
      org_id: string;
      status: string;
      started: boolean;
      interrupted: boolean;
      limited: boolean;
      metadata_bytes: number;
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
         metadata    = (t.metadata || $8::jsonb) - $9::text[],
         updated_at  = now()
       FROM loopway.threads o
       WHERE o.id = t.id AND ${THREAD_OWNED}
       RETURNING t.org_id, t.status, t.started, t.interrupted, t.limited,
                 octet_length(t.metadata::text) AS metadata_bytes,
                 o.status AS old_status, o.started AS old_started, o.interrupted AS old_interrupted,
                 o.limited AS old_limited`,
      [
        botId,
        token,
        id,
        patch.status ?? null,
        patch.started ?? null,
        patch.interrupted ?? null,
        patch.limited ?? null,
        patch.metadataSet ?? {},
        patch.metadataUnset ?? [],
      ],
    );
    if (!upd.length) return false;
    const u = upd[0]!;
    // Throwing rolls the whole update back.
    if (u.metadata_bytes > METADATA_MAX_BYTES)
      throw new ApiError(400, "metadata_too_large", `A thread's metadata can be at most ${METADATA_MAX_BYTES} bytes`);
    const kinds: ThreadEventKind[] = [];
    if (u.started && !u.old_started) kinds.push("started");
    if (u.interrupted && !u.old_interrupted) kinds.push("interrupted");
    if (u.limited && !u.old_limited) kinds.push("limited");
    if (!u.limited && u.old_limited) kinds.push("limit_cleared");
    if (u.status === "ended" && u.old_status !== "ended") kinds.push("ended");
    if (kinds.length) await recordThreadEvents(tx, u.org_id, botId, id, kinds);
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
): Promise<{ moved: number; firstRun?: { orgId: string; seconds: number } } | undefined> {
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
    if (requeue || !moved.length) return { moved: moved.length };
    // The org's first delivered messages: all of its bots' delivered messages are the ones just moved.
    const [first] = await tx.query<{ id: string; seconds: number }>(
      `SELECT o.id, extract(epoch FROM now() - o.created_at)::float8 AS seconds
       FROM loopway.bots b JOIN loopway.orgs o ON o.id = b.org_id
       WHERE b.id = $1 AND NOT EXISTS (
         SELECT 1 FROM loopway.thread_messages tm JOIN loopway.bots ob ON ob.id = tm.bot_id
         WHERE ob.org_id = o.id AND tm.state = 'delivered' AND NOT (tm.thread_id = $2::uuid AND tm.delivered_at = now()))`,
      [botId, id],
    );
    return { moved: moved.length, firstRun: first && { orgId: first.id, seconds: first.seconds } };
  });
}

// ---------- Org members ----------

/** Emails are keyed the way login keys them: trimmed (by the API) and lowercased. */
const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface OrgMember {
  id: string;
  username: string | null;
  email: string | null;
}

export interface OrgMembers {
  members: OrgMember[];
  /** Emails added before they had an account. */
  pending: string[];
}

export async function listOrgMembers(db: Q, orgId: string): Promise<OrgMembers> {
  const members = await db.query<OrgMember>(
    `SELECT u.id, u.email, (SELECT o.slug FROM loopway.orgs o WHERE o.personal_user_id = u.id) AS username
     FROM loopway.org_members m JOIN loopway.users u ON u.id = m.user_id
     WHERE m.org_id = $1 ORDER BY m.created_at, u.id`,
    [orgId],
  );
  const pending = await db.query<{ email: string }>(
    `SELECT email FROM loopway.org_invites WHERE org_id = $1 AND ${LIVE_INVITE} ORDER BY created_at, email`,
    [orgId],
  );
  return { members, pending: pending.map((r) => r.email) };
}

/**
 * Adds the email to the org: as a member if a user has it, else as a pending membership that their first login
 * claims (the member then keeps the invite's `created_by`). Adding someone already there changes nothing.
 * A personal org takes no one: "personal_org", and nothing is stored (the database refuses it too).
 */
export async function addOrgMember(
  db: Db,
  orgId: string,
  addedBy: string,
  email: string,
): Promise<"member" | "pending" | "already_member" | "already_pending" | "personal_org"> {
  const addr = normalizeEmail(email);
  return db.transaction(async (tx) => {
    const [org] = await tx.query<{ personal_user_id: string | null }>(
      `SELECT personal_user_id FROM loopway.orgs WHERE id = $1`,
      [orgId],
    );
    if (org?.personal_user_id) return "personal_org";
    const [user] = await tx.query<{ id: string }>(`SELECT id FROM loopway.users WHERE lower(email) = $1 LIMIT 1`, [
      addr,
    ]);
    if (user) {
      const added = await tx.query(
        `INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING user_id`,
        [orgId, user.id, userActor(addedBy)],
      );
      // A pending row for the same email (added before they signed up) is now redundant.
      await tx.query(`DELETE FROM loopway.org_invites WHERE org_id = $1 AND email = $2`, [orgId, addr]);
      return added.length ? "member" : "already_member";
    }
    // An expired invite for this email is replaced by a fresh one.
    await tx.query(`DELETE FROM loopway.org_invites WHERE org_id = $1 AND email = $2 AND NOT (${LIVE_INVITE})`, [
      orgId,
      addr,
    ]);
    const added = await tx.query(
      `INSERT INTO loopway.org_invites (org_id, email, created_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING email`,
      [orgId, addr, userActor(addedBy)],
    );
    return added.length ? "pending" : "already_pending";
  });
}

/**
 * Removes a member. "last_member" when they are the only one left, "personal_owner" when they own the personal org
 * (they stay in it), "not_a_member" when they weren't one.
 */
export async function removeOrgMember(
  db: Db,
  orgId: string,
  userId: string,
): Promise<"removed" | "last_member" | "personal_owner" | "not_a_member"> {
  return db.transaction(async (tx) => {
    // Serializes removals from one org, so two members leaving at once can't both pass the count.
    const [org] = await tx.query<{ personal_user_id: string | null }>(
      `SELECT personal_user_id FROM loopway.orgs WHERE id = $1 FOR UPDATE`,
      [orgId],
    );
    const members = await tx.query<{ user_id: string }>(`SELECT user_id FROM loopway.org_members WHERE org_id = $1`, [
      orgId,
    ]);
    if (!members.some((m) => m.user_id === userId)) return "not_a_member";
    if (members.length <= 1) return "last_member";
    if (org?.personal_user_id === userId) return "personal_owner";
    await tx.query(`DELETE FROM loopway.org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    return "removed";
  });
}

/** Withdraws a pending membership. False if the email wasn't pending. */
export async function removeOrgInvite(db: Q, orgId: string, email: string): Promise<boolean> {
  const gone = await db.query(`DELETE FROM loopway.org_invites WHERE org_id = $1 AND email = $2 RETURNING email`, [
    orgId,
    normalizeEmail(email),
  ]);
  return gone.length > 0;
}
