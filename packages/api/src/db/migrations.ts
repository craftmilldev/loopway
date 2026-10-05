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
];
