// Shared setup for the API tests. Importing this gives the test file its own app and database.

import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import { createApi } from "../src/api.js";
import { type Db } from "../src/db/index.js";
import { openTestDb, TEST_INBOX_KEY } from "../src/db/testing.js";
import { createLoginCode, createUser } from "../src/store.js";
import { signSessionToken } from "../src/tokens.js";

export const SECRET = "test-secret";

export let db: Db;
export let app: ReturnType<typeof createApi>;
/** The metrics events the API has recorded in this file's tests. */
export const events: { event: string; distinctId: string; properties?: Record<string, unknown> }[] = [];

// Each test file gets its own migrated database on the local Postgres (`npm run db:up`).
beforeAll(async () => {
  db = await openTestDb();
  app = createApi({
    getDb: async () => db,
    publicBaseUrl: "https://loopway.test",
    tokenSecret: SECRET,
    inboxSecretKey: TEST_INBOX_KEY,
    metrics: { capture: async (event, distinctId, properties) => void events.push({ event, distinctId, properties }) },
  });
});
afterAll(() => db.close());

/** Calls the API as `key`. */
export async function call(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await app.request("/api" + path, {
    method,
    headers: {
      ...opts.headers,
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let signups = 0;

/** Signs a new user up through `POST /auth/verify`, as a real signup does, and returns their session token. */
export async function newUser(name = "Matthew") {
  const n = ++signups;
  const email = `user${n}@example.com`;
  const { code } = await createLoginCode(db, email);
  const username = `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${n}`;
  const res = await call("POST", "/auth/verify", { body: { email, code, username } });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

/** A user who hasn't picked a username yet. */
export async function newUserWithoutUsername(name = "Matthew") {
  const { user } = await createUser(db, { name });
  return signSessionToken(user.id, SECRET).token;
}

/** The id of the user `key` belongs to: the last part of their inbox URL. */
export async function userId(key: string) {
  return (await call("GET", "/me", { key })).body.id as string;
}

/** Registers a source, GitHub by default, and returns what the API said plus where to deliver to it. */
export async function newSource(key: string, body: Record<string, unknown> = { type: "github" }) {
  const r = await call("POST", "/sources", { key, body });
  expect(r.status).toBe(201);
  return { ...r.body, userId: await userId(key) } as {
    id: string;
    name: string;
    userId: string;
    secret: string;
    webhook_url: string;
  };
}

// GitHub is the source the source-agnostic tests use to get events into an inbox.

export function sendGithub(
  source: { userId: string; secret: string },
  event: string,
  payload: unknown,
  o: { delivery?: string; secret?: string; form?: boolean } = {},
) {
  const raw = o.form ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString() : JSON.stringify(payload);
  const sig =
    "sha256=" +
    createHmac("sha256", o.secret ?? source.secret)
      .update(raw)
      .digest("hex");
  return app.request(`/api/webhooks/${source.userId}`, {
    method: "POST",
    headers: {
      "content-type": o.form ? "application/x-www-form-urlencoded" : "application/json",
      "x-github-event": event,
      "x-github-delivery": o.delivery ?? randomUUID(),
      "x-hub-signature-256": sig,
    },
    body: raw,
  });
}

export const prPayload = (n: number) => ({
  action: "opened",
  number: n,
  pull_request: { updated_at: "2026-10-01T12:00:00Z" },
  repository: { url: "https://api.github.com/repos/craftmill/loopway" },
});

/** Reads every message a test can see, past the holdback: `since=0` with the row's received_at moved back. */
export async function ageMessages(seconds = 60) {
  await db.query(`UPDATE loopway.messages SET received_at = received_at - make_interval(secs => $1)`, [seconds]);
}

/** All of a user's messages, oldest first. */
export async function readAll(key: string) {
  await ageMessages();
  return (await call("GET", "/messages?since=0&limit=100", { key })).body.data as {
    id: string;
    source_id: string | null;
    received_at: string;
    received_us: string;
    event: { id: string; type: string; subject?: string; source: string; time: string; data: never };
  }[];
}
