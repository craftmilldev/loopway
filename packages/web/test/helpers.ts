// Shared setup for the API tests. Importing this gives the test file its own app and database.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import { createApi } from "../src/api.js";
import { type Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { createUser, setUsername } from "../src/store.js";
import { signSessionToken } from "../src/tokens.js";

export const SECRET = "test-secret";

export let db: Db;
export let app: ReturnType<typeof createApi>;

// Each test file gets its own migrated database on the local Postgres (`npm run db:up`).
beforeAll(async () => {
  db = await openTestDb();
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

/** A user with a personal org, as signup makes them. */
export async function newUser(name = "Matthew") {
  const { user } = await createUser(db, { name });
  const username = `u-${randomBytes(6).toString("hex")}`;
  expect(await setUsername(db, user.id, username)).toMatchObject({ ok: true });
  return signSessionToken(user.id, SECRET).token;
}

/** A user who hasn't picked a username yet, so has no personal org. */
export async function newUserWithoutOrg(name = "Matthew") {
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
