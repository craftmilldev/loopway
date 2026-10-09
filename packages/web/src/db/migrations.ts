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
];
