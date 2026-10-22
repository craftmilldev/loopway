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

const personalOrgs = new Map<string, string>();

const LISTS = ["/inboxes", "/bots", "/runners", "/events", "/inboxes/activity", "/bots/activity"];

/**
 * Calls the API as `key`. Creating an inbox, bot or runner needs an `org`, and so does listing them; unless the body
 * or query names one (or `noOrg` is set, to test its absence) the caller's personal org is filled in, so tests needn't
 * repeat it.
 */
export async function call(method: string, path: string, opts: { key?: string; body?: unknown; noOrg?: boolean } = {}) {
  const [route = "", query = ""] = path.split("?");
  const named = opts.body && typeof opts.body === "object" && "org" in opts.body;
  const fill =
    opts.key &&
    !opts.noOrg &&
    ((method === "POST" && ["/inboxes", "/bots", "/runners"].includes(path) && !!opts.body && !named) ||
      (method === "GET" && LISTS.includes(route) && !new URLSearchParams(query).has("org")));
  if (fill) {
    if (!personalOrgs.has(opts.key!)) {
      const orgs = await call("GET", "/orgs", { key: opts.key });
      personalOrgs.set(opts.key!, orgs.body.data.find((o: { personal: boolean }) => o.personal).slug);
    }
    const org = personalOrgs.get(opts.key!)!;
    if (method === "GET") path += `${query ? "&" : "?"}org=${org}`;
    else {
      opts = { ...opts, body: { ...(opts.body as Record<string, unknown>), org } };
    }
  }
  const res = await app.request("/api" + path, {
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
  return app.request(`/api/webhooks/${inbox.id}`, {
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
