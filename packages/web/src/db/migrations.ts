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
];
