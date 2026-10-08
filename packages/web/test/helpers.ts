// Shared setup for the API tests. Importing this gives the test file its own app and database.

import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import { createApi } from "../src/api.js";
import { migrate, openDb, type Db } from "../src/db/index.js";
import { createUser } from "../src/store.js";
import { signSessionToken } from "../src/tokens.js";

export const SECRET = "test-secret";

export let db: Db;
export let app: ReturnType<typeof createApi>;

// Runs against in-memory PGlite by default. Set TEST_DATABASE_URL to run against a real Postgres
// (the `loopway` schema in that database is dropped and recreated!).
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  db = await openDb(url ? { databaseUrl: url } : { pgliteDir: "memory://" });
  if (url) {
    await db.query("DROP SCHEMA IF EXISTS loopway CASCADE");
    await migrate(db);
  }
  app = createApi({ getDb: async () => db, publicBaseUrl: "https://loopway.test", tokenSecret: SECRET });
});
afterAll(() => db.close());

export async function call(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const res = await app.request(path, {
    method,
    headers: {
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function newUser(name = "Matthew") {
  const { user } = await createUser(db, { name });
  return signSessionToken(user.id, SECRET).token;
}

// GitHub is the source the source-agnostic tests use to get events into an inbox.

export async function newInbox(key: string, config?: unknown) {
  const r = await call("POST", "/inboxes", { key, body: { name: "gh", source_type: "github", config } });
  expect(r.status).toBe(201);
  return r.body as { id: string; config: { secret: string }; webhook_url: string };
}

export function sendGithub(
  inbox: { id: string; config: { secret: string } },
  event: string,
  payload: unknown,
  o: { delivery?: string; secret?: string; form?: boolean } = {},
) {
  const raw = o.form ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString() : JSON.stringify(payload);
  const sig =
    "sha256=" +
    createHmac("sha256", o.secret ?? inbox.config.secret)
      .update(raw)
      .digest("hex");
  return app.request(`/webhooks/${inbox.id}`, {
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
