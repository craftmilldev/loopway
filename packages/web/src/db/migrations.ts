/**
 * Migrations live in TS (not .sql files) so they're bundled into the Vercel function.
 * Append new entries; never edit an applied one.
 *
 * Everything is in a `loopway` schema (not `public`), and RLS is enabled with no policies, so a
 * PostgREST-style Data API (e.g. Neon's, if ever turned on) can't reach it. The app connects as the table owner.
 */
export const migrations: { version: string; sql: string }[] = [
  {
    version: "001_init",
    sql: `
CREATE TABLE loopway.users (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  email         text UNIQUE,
  api_key_hash  text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE loopway.inboxes (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES loopway.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  source_type  text NOT NULL,
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inboxes_user_idx ON loopway.inboxes (user_id);

CREATE TABLE loopway.events (
  id            uuid PRIMARY KEY,
  inbox_id      uuid NOT NULL REFERENCES loopway.inboxes(id) ON DELETE CASCADE,
  ce_id         text NOT NULL,
  ce_source     text NOT NULL,
  ce_type       text NOT NULL,
  ce_subject    text,
  ce_time       timestamptz,
  cloudevent    jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  lock_token    text,
  locked_until  timestamptz,
  lock_count    integer NOT NULL DEFAULT 0,
  processed_at  timestamptz,
  CONSTRAINT events_ce_unique UNIQUE (inbox_id, ce_source, ce_id)
);

CREATE INDEX events_inbox_idx ON loopway.events (inbox_id, id);

CREATE INDEX events_unprocessed_idx ON loopway.events (inbox_id, id) WHERE processed_at IS NULL;

ALTER TABLE loopway.users   ENABLE ROW LEVEL SECURITY;

ALTER TABLE loopway.inboxes ENABLE ROW LEVEL SECURITY;

ALTER TABLE loopway.events  ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    version: "002_login_codes",
    sql: `
CREATE TABLE loopway.login_codes (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL UNIQUE REFERENCES loopway.users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE loopway.login_codes ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    // Codes are now keyed by email so they can be issued before the user exists. They live 10 minutes, so drop them.
    version: "003_login_codes_by_email",
    sql: `
DROP TABLE loopway.login_codes;
CREATE TABLE loopway.login_codes (
  id          uuid PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE loopway.login_codes ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    // Sessions are JWTs and nothing reads the stored key hash any more.
    version: "004_drop_api_key_hash",
    sql: `
ALTER TABLE loopway.users DROP COLUMN api_key_hash;
`,
  },
  {
    // seq orders events for bots: it's assigned at insert, so unlike the UUIDv7 id it doesn't depend on which
    // instance's clock made the row. A plain `ADD COLUMN seq bigserial` would number existing rows in disk order,
    // so they're numbered by id first and the sequence is attached after.
    // bot_inboxes carries user_id so the composite keys can require the bot and inbox to share an owner.
    version: "005_bots",
    sql: `
ALTER TABLE loopway.events ADD COLUMN seq bigint;

UPDATE loopway.events e SET seq = n.seq
FROM (SELECT id, row_number() OVER (ORDER BY id) AS seq FROM loopway.events) n
WHERE e.id = n.id;

CREATE SEQUENCE loopway.events_seq_seq OWNED BY loopway.events.seq;

SELECT setval('loopway.events_seq_seq', COALESCE((SELECT max(seq) FROM loopway.events), 0) + 1, false);

ALTER TABLE loopway.events
  ALTER COLUMN seq SET DEFAULT nextval('loopway.events_seq_seq'),
  ALTER COLUMN seq SET NOT NULL;

CREATE UNIQUE INDEX events_seq_idx ON loopway.events (seq);

ALTER TABLE loopway.inboxes ADD CONSTRAINT inboxes_id_user_unique UNIQUE (id, user_id);

CREATE TABLE loopway.bots (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES loopway.users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          text NOT NULL,
  cursor        bigint NOT NULL DEFAULT 0,
  lock_token    text,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT bots_id_user_unique UNIQUE (id, user_id)
);

CREATE INDEX bots_user_idx ON loopway.bots (user_id);

CREATE TABLE loopway.bot_inboxes (
  bot_id    uuid NOT NULL,
  inbox_id  uuid NOT NULL,
  user_id   uuid NOT NULL,
  PRIMARY KEY (bot_id, inbox_id),
  FOREIGN KEY (bot_id, user_id) REFERENCES loopway.bots(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (inbox_id, user_id) REFERENCES loopway.inboxes(id, user_id) ON DELETE CASCADE
);

CREATE INDEX bot_inboxes_inbox_idx ON loopway.bot_inboxes (inbox_id);

ALTER TABLE loopway.bots        ENABLE ROW LEVEL SECURITY;

ALTER TABLE loopway.bot_inboxes ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    // Bots read by cursor (005), so events are no longer locked or marked processed one at a time.
    version: "006_drop_event_locks",
    sql: `
DROP INDEX loopway.events_unprocessed_idx;

ALTER TABLE loopway.events
  DROP COLUMN lock_token,
  DROP COLUMN locked_until,
  DROP COLUMN lock_count,
  DROP COLUMN processed_at;
`,
  },
  {
    // Stored events are now messages. Run this before deploying the code that reads loopway.messages.
    version: "007_events_to_messages",
    sql: `
ALTER TABLE loopway.events RENAME TO messages;

ALTER TABLE loopway.messages RENAME CONSTRAINT events_ce_unique TO messages_ce_unique;

ALTER TABLE loopway.messages RENAME CONSTRAINT events_pkey TO messages_pkey;

ALTER INDEX loopway.events_inbox_idx RENAME TO messages_inbox_idx;

ALTER INDEX loopway.events_seq_idx RENAME TO messages_seq_idx;

ALTER SEQUENCE loopway.events_seq_seq RENAME TO messages_seq_seq;
`,
  },
  {
    // Threads (agent sessions) move to the server. A thread belongs to one bot; its id is the Claude session id.
    // A thread's subjects are the things it works on (for GitHub, `owner/repo#number` of its issues and PRs); a
    // subject belongs to one thread per bot, and assigning a message finds the thread by the message's subjects.
    // The composite keys make a thread's subjects and messages share its bot. thread_messages.state is
    // waiting (assigned, not handed to a run), inflight (handed to a run that hasn't finished) or delivered.
    version: "008_threads",
    sql: `
CREATE TABLE loopway.threads (
  id           uuid PRIMARY KEY,
  bot_id       uuid NOT NULL,
  user_id      uuid NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started      boolean NOT NULL DEFAULT false,
  interrupted  boolean NOT NULL DEFAULT false,
  limited      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT threads_id_bot_unique UNIQUE (id, bot_id),
  FOREIGN KEY (bot_id, user_id) REFERENCES loopway.bots(id, user_id) ON DELETE CASCADE
);

CREATE INDEX threads_bot_idx ON loopway.threads (bot_id, status);

CREATE TABLE loopway.thread_subjects (
  thread_id  uuid NOT NULL,
  bot_id     uuid NOT NULL,
  subject    text NOT NULL,
  PRIMARY KEY (bot_id, subject),
  FOREIGN KEY (thread_id, bot_id) REFERENCES loopway.threads(id, bot_id) ON DELETE CASCADE
);

CREATE INDEX thread_subjects_thread_idx ON loopway.thread_subjects (thread_id);

CREATE TABLE loopway.thread_messages (
  thread_id     uuid NOT NULL,
  bot_id        uuid NOT NULL,
  message_id    uuid NOT NULL REFERENCES loopway.messages(id) ON DELETE CASCADE,
  state         text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'inflight', 'delivered')),
  subject       text,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  UNIQUE (bot_id, message_id),
  FOREIGN KEY (thread_id, bot_id) REFERENCES loopway.threads(id, bot_id) ON DELETE CASCADE
);

CREATE INDEX thread_messages_thread_idx ON loopway.thread_messages (thread_id, state);

ALTER TABLE loopway.threads         ENABLE ROW LEVEL SECURITY;

ALTER TABLE loopway.thread_subjects ENABLE ROW LEVEL SECURITY;

ALTER TABLE loopway.thread_messages ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    // A runner is a machine running loopway (its id is made by the CLI). It holds one lease, so only one process uses
    // a runner id at a time. A bot records the runner that holds its lease (bots.runner_id, meaningful while the bot's
    // locked_until is in the future). A thread belongs to a runner (threads.runner_id) for good, since its session
    // lives on that machine, until someone releases it; writing it needs the owner's live lease.
    version: "009_runners",
    sql: `
CREATE TABLE loopway.runners (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES loopway.users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  lock_token    text,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX runners_user_idx ON loopway.runners (user_id);

ALTER TABLE loopway.runners ENABLE ROW LEVEL SECURITY;

ALTER TABLE loopway.bots ADD COLUMN runner_id uuid REFERENCES loopway.runners(id) ON DELETE SET NULL;

ALTER TABLE loopway.threads ADD COLUMN runner_id uuid REFERENCES loopway.runners(id) ON DELETE SET NULL;

CREATE INDEX threads_runner_idx ON loopway.threads (runner_id);
`,
  },
  {
    // Which model a bot's sessions run on. Existing bots get sonnet; until now they ran on whatever `claude`
    // defaulted to, which nobody had chosen.
    version: "010_bot_model",
    sql: `
ALTER TABLE loopway.bots ADD COLUMN model text NOT NULL DEFAULT 'sonnet';

ALTER TABLE loopway.bots ALTER COLUMN model DROP DEFAULT;
`,
  },
  {
    // A bot's prompt is versioned: each change appends a row, and the bot's current version is its highest. Rows are
    // never updated, so the history of a bot's instructions stays. Bots made before this have no version until a
    // runner posts one.
    version: "011_bot_versions",
    sql: `
CREATE TABLE loopway.bot_versions (
  bot_id      uuid NOT NULL REFERENCES loopway.bots(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  prompt      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, version)
);

ALTER TABLE loopway.bot_versions ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    // A version also holds the bot's assign rules (see BotRule in @loopway/rules). Versions made before this have none until
    // a runner posts a new version with its kind's rules.
    version: "012_bot_version_rules",
    sql: `
ALTER TABLE loopway.bot_versions ADD COLUMN rules jsonb;
`,
  },
  {
    // 012's first writes passed the rules pre-stringified, which postgres.js stores as a JSON string. Unwrap them.
    version: "013_unwrap_bot_version_rules",
    sql: `
UPDATE loopway.bot_versions SET rules = (rules #>> '{}')::jsonb WHERE jsonb_typeof(rules) = 'string';
`,
  },
  {
    // A bot is its prompt and rules, not a kind.
    version: "014_drop_bot_kind",
    sql: `
ALTER TABLE loopway.bots DROP COLUMN kind;
`,
  },
  {
    // Bot activity (deliveries per day, last delivery) reads a bot's delivered rows by time.
    version: "015_thread_messages_delivered_idx",
    sql: `
CREATE INDEX thread_messages_delivered_idx ON loopway.thread_messages (bot_id, delivered_at) WHERE delivered_at IS NOT NULL;
`,
  },
  {
    // What happened to each thread and when, for the overview's feed: threads keep only their current flags. Rows are
    // written at each transition and die with their thread. No backfill.
    version: "016_thread_events",
    sql: `
CREATE TABLE loopway.thread_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL,
  bot_id     uuid NOT NULL,
  thread_id  uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('created', 'started', 'ended', 'interrupted', 'limited', 'limit_cleared')),
  at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (thread_id, bot_id) REFERENCES loopway.threads(id, bot_id) ON DELETE CASCADE,
  FOREIGN KEY (bot_id, user_id) REFERENCES loopway.bots(id, user_id) ON DELETE CASCADE
);

CREATE INDEX thread_events_user_at_idx ON loopway.thread_events (user_id, at DESC);

ALTER TABLE loopway.thread_events ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    // Orgs and their members, with one personal org per user: its slug is the user's username, and
    // personal_user_id says whose it is. Nothing is owned by an org yet. Only matthew@craftmill.dev exists to migrate:
    // he becomes mcwhittemore and joins a craftmill org. Where he doesn't exist (tests, fresh databases) that's a no-op.
    version: "017_orgs",
    sql: `
CREATE TABLE loopway.orgs (
  id                uuid PRIMARY KEY,
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,37}[a-z0-9]$'),
  name              text NOT NULL,
  personal_user_id  uuid UNIQUE REFERENCES loopway.users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE loopway.org_members (
  org_id      uuid NOT NULL REFERENCES loopway.orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES loopway.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX org_members_user_idx ON loopway.org_members (user_id);

ALTER TABLE loopway.orgs ENABLE ROW LEVEL SECURITY;

ALTER TABLE loopway.org_members ENABLE ROW LEVEL SECURITY;

INSERT INTO loopway.orgs (id, slug, name, personal_user_id)
SELECT gen_random_uuid(), 'mcwhittemore', 'mcwhittemore', id FROM loopway.users WHERE lower(email) = 'matthew@craftmill.dev';

INSERT INTO loopway.orgs (id, slug, name)
SELECT gen_random_uuid(), 'craftmill', 'craftmill' FROM loopway.users WHERE lower(email) = 'matthew@craftmill.dev';

INSERT INTO loopway.org_members (org_id, user_id)
SELECT o.id, u.id FROM loopway.users u JOIN loopway.orgs o ON o.personal_user_id = u.id OR o.slug = 'craftmill'
WHERE lower(u.email) = 'matthew@craftmill.dev';
`,
  },
  {
    // Records which org owns each inbox, bot, bot_inbox, thread and runner. user_id stays and still decides access; this
    // only adds the data (and the rule that a bot and its inboxes, or a thread and its bot, share an org).
    // Everything matthew@craftmill.dev owns goes to craftmill, everything else to its owner's personal org. Where those
    // users or orgs don't exist (tests, fresh databases) there are no rows to backfill.
    version: "018_org_ownership",
    sql: `
ALTER TABLE loopway.inboxes      ADD COLUMN org_id uuid REFERENCES loopway.orgs(id);

ALTER TABLE loopway.bots         ADD COLUMN org_id uuid REFERENCES loopway.orgs(id);

ALTER TABLE loopway.bot_inboxes  ADD COLUMN org_id uuid REFERENCES loopway.orgs(id);

ALTER TABLE loopway.threads      ADD COLUMN org_id uuid REFERENCES loopway.orgs(id);

ALTER TABLE loopway.runners      ADD COLUMN org_id uuid REFERENCES loopway.orgs(id);

CREATE TEMP TABLE owner_orgs ON COMMIT DROP AS
SELECT u.id AS user_id,
       CASE WHEN lower(u.email) = 'matthew@craftmill.dev'
            THEN (SELECT id FROM loopway.orgs WHERE slug = 'craftmill')
            ELSE (SELECT id FROM loopway.orgs WHERE personal_user_id = u.id) END AS org_id
FROM loopway.users u;

UPDATE loopway.inboxes     t SET org_id = x.org_id FROM owner_orgs x WHERE x.user_id = t.user_id;

UPDATE loopway.bots        t SET org_id = x.org_id FROM owner_orgs x WHERE x.user_id = t.user_id;

UPDATE loopway.bot_inboxes t SET org_id = x.org_id FROM owner_orgs x WHERE x.user_id = t.user_id;

UPDATE loopway.threads     t SET org_id = x.org_id FROM owner_orgs x WHERE x.user_id = t.user_id;

UPDATE loopway.runners     t SET org_id = x.org_id FROM owner_orgs x WHERE x.user_id = t.user_id;

ALTER TABLE loopway.inboxes     ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE loopway.bots        ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE loopway.bot_inboxes ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE loopway.threads     ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE loopway.runners     ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE loopway.inboxes ADD CONSTRAINT inboxes_id_org_unique UNIQUE (id, org_id);

ALTER TABLE loopway.bots    ADD CONSTRAINT bots_id_org_unique UNIQUE (id, org_id);

ALTER TABLE loopway.bot_inboxes
  ADD CONSTRAINT bot_inboxes_bot_org_fkey   FOREIGN KEY (bot_id, org_id)   REFERENCES loopway.bots(id, org_id)    ON DELETE CASCADE,
  ADD CONSTRAINT bot_inboxes_inbox_org_fkey FOREIGN KEY (inbox_id, org_id) REFERENCES loopway.inboxes(id, org_id) ON DELETE CASCADE;

ALTER TABLE loopway.threads
  ADD CONSTRAINT threads_bot_org_fkey FOREIGN KEY (bot_id, org_id) REFERENCES loopway.bots(id, org_id) ON DELETE CASCADE;
`,
  },
  {
    // Access is by org membership now, so a bot, its inboxes and its threads may have different user_ids as long as
    // they share an org (which 018's keys enforce). Drops the keys that tied them to one user. user_id stays as the creator.
    version: "019_org_access",
    sql: `
ALTER TABLE loopway.bot_inboxes
  DROP CONSTRAINT bot_inboxes_bot_id_user_id_fkey,
  DROP CONSTRAINT bot_inboxes_inbox_id_user_id_fkey;

ALTER TABLE loopway.threads DROP CONSTRAINT threads_bot_id_user_id_fkey;

ALTER TABLE loopway.thread_events DROP CONSTRAINT thread_events_bot_id_user_id_fkey;
`,
  },
  {
    // Members added by an email that has no account yet. Whoever first logs in with the email joins the org (and the
    // row goes). email is stored trimmed and lowercased, as login does.
    version: "020_org_invites",
    sql: `
CREATE TABLE loopway.org_invites (
  org_id      uuid NOT NULL REFERENCES loopway.orgs(id) ON DELETE CASCADE,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, email)
);

CREATE INDEX org_invites_email_idx ON loopway.org_invites (email);

ALTER TABLE loopway.org_invites ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    // A personal org has exactly one member, its owner. Triggers keep it so for every path that writes members or
    // invites. The function bodies sit on one line each because migrations are split on line-ending semicolons.
    version: "021_personal_org_members",
    sql: `
CREATE FUNCTION loopway.guard_personal_org_member() RETURNS trigger AS $$ BEGIN IF EXISTS (SELECT 1 FROM loopway.orgs WHERE id = NEW.org_id AND personal_user_id IS NOT NULL AND personal_user_id <> NEW.user_id) THEN RAISE EXCEPTION 'personal orgs can only have their owner as a member'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TRIGGER org_members_personal_guard BEFORE INSERT OR UPDATE ON loopway.org_members FOR EACH ROW EXECUTE FUNCTION loopway.guard_personal_org_member();

CREATE FUNCTION loopway.guard_personal_org_invite() RETURNS trigger AS $$ BEGIN IF EXISTS (SELECT 1 FROM loopway.orgs WHERE id = NEW.org_id AND personal_user_id IS NOT NULL) THEN RAISE EXCEPTION 'personal orgs can not have pending invites'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TRIGGER org_invites_personal_guard BEFORE INSERT OR UPDATE ON loopway.org_invites FOR EACH ROW EXECUTE FUNCTION loopway.guard_personal_org_invite();
`,
  },
  {
    // user_id only recorded who made a row, but it read as ownership and forced a user where the maker may be a bot or
    // a runner. created_by replaces it on inboxes, bots, runners and threads: an actor reference (user:<uuid>,
    // bot:<uuid> or runner:<id>) with no foreign key. Nothing reads it for access. This adds and fills the column;
    // 023 and 024 finish the move off user_id.
    version: "022_created_by",
    sql: `
ALTER TABLE loopway.inboxes ADD COLUMN created_by text;

ALTER TABLE loopway.bots    ADD COLUMN created_by text;

ALTER TABLE loopway.runners ADD COLUMN created_by text;

ALTER TABLE loopway.threads ADD COLUMN created_by text;

UPDATE loopway.inboxes SET created_by = 'user:' || user_id;

UPDATE loopway.bots    SET created_by = 'user:' || user_id;

UPDATE loopway.runners SET created_by = 'user:' || user_id;

UPDATE loopway.threads SET created_by = CASE WHEN runner_id IS NOT NULL THEN 'runner:' || runner_id ELSE 'bot:' || bot_id END;

ALTER TABLE loopway.inboxes ALTER COLUMN created_by SET NOT NULL;

ALTER TABLE loopway.bots    ALTER COLUMN created_by SET NOT NULL;

ALTER TABLE loopway.runners ALTER COLUMN created_by SET NOT NULL;

ALTER TABLE loopway.threads ALTER COLUMN created_by SET NOT NULL;
`,
  },
  {
    // thread_events and bot_inboxes only carried user_id for access or listing. thread_events reads by org now, so it
    // gets org_id (from its bot) and an org-scoped index in place of the per-user one.
    version: "023_thread_events_org",
    sql: `
ALTER TABLE loopway.thread_events ADD COLUMN org_id uuid REFERENCES loopway.orgs(id);

UPDATE loopway.thread_events e SET org_id = b.org_id FROM loopway.bots b WHERE b.id = e.bot_id;

ALTER TABLE loopway.thread_events ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX thread_events_org_at_idx ON loopway.thread_events (org_id, at DESC);

DROP INDEX loopway.thread_events_user_at_idx;
`,
  },
  {
    // Nothing reads user_id any more: drops it, and the key and indexes that used it, from every table but org_members.
    version: "024_drop_user_id",
    sql: `
ALTER TABLE loopway.thread_events DROP COLUMN user_id;

ALTER TABLE loopway.bot_inboxes DROP COLUMN user_id;

ALTER TABLE loopway.threads DROP COLUMN user_id;

ALTER TABLE loopway.inboxes DROP CONSTRAINT inboxes_id_user_unique;

DROP INDEX loopway.inboxes_user_idx;

DROP INDEX loopway.bots_user_idx;

DROP INDEX loopway.runners_user_idx;

ALTER TABLE loopway.inboxes DROP COLUMN user_id;

ALTER TABLE loopway.bots    DROP COLUMN user_id;

ALTER TABLE loopway.runners DROP COLUMN user_id;
`,
  },
  {
    // Who added each member and invite, as an actor like the other created_by columns. A member who added themselves
    // (their personal org, or an org they made) is their own creator; one who joined from an invite keeps the
    // invite's. Existing rows predate this: members are recorded as their own, invites as their org's first member.
    version: "025_member_created_by",
    sql: `
ALTER TABLE loopway.org_members ADD COLUMN created_by text;

ALTER TABLE loopway.org_invites ADD COLUMN created_by text;

UPDATE loopway.org_members SET created_by = 'user:' || user_id;

DELETE FROM loopway.org_invites i WHERE NOT EXISTS (SELECT 1 FROM loopway.org_members m WHERE m.org_id = i.org_id);

UPDATE loopway.org_invites i SET created_by = 'user:' || (
  SELECT m.user_id FROM loopway.org_members m WHERE m.org_id = i.org_id ORDER BY m.created_at, m.user_id LIMIT 1);

ALTER TABLE loopway.org_members ALTER COLUMN created_by SET NOT NULL;

ALTER TABLE loopway.org_invites ALTER COLUMN created_by SET NOT NULL;
`,
  },
  {
    // Which coding-agent CLI a bot's sessions run in. Until now every bot ran in Claude Code, so existing bots get claude; new ones must say.
    version: "026_bot_harness",
    sql: `
ALTER TABLE loopway.bots ADD COLUMN harness text NOT NULL DEFAULT 'claude';

ALTER TABLE loopway.bots ALTER COLUMN harness DROP DEFAULT;
`,
  },
  {
    // Whether a person or a bot made each message, from its source's metadata (null: unknown, or no author), and a
    // thread's level of automation: 2 if a person started it, 3 if a bot did but a person took part, 4 if none did.
    version: "027_automation_level",
    sql: `
ALTER TABLE loopway.messages ADD COLUMN author_kind text CHECK (author_kind IN ('human', 'bot'));

ALTER TABLE loopway.threads ADD COLUMN automation_level smallint CHECK (automation_level BETWEEN 2 AND 4);
`,
  },
];
