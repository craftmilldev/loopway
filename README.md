# loopway

Accepts webhooks from defined sources, stores them as [CloudEvents](https://github.com/cloudevents/spec) in a per-user **inbox**, and exposes an API to list, lock, claim, and mark events processed.

- **Stack:** TypeScript + [Hono](https://hono.dev), zero-config on Vercel.
- **DB:** Postgres everywhere. Locally [PGlite](https://pglite.dev) (embedded, no server); on Vercel, [Neon](https://neon.tech) via `DATABASE_URL`. Same SQL on both.
- **Data types:** `User` → owns `Inbox`es → which receive `Event`s.
- **Sources:** `github` (more can be added in `src/sources/`).

## Run locally

```bash
npm install
cp .env.example .env
npm run dev                   # http://localhost:3000, data in ./.data/pglite
npm test                      # in-memory PGlite
```

Create a user (with the server stopped — PGlite allows one process at a time):

```bash
npm run user:create -- --name Matthew [--email you@example.com]
# → { "user": {...}, "api_key": "lw_..." }   only the hash is stored; save the key
```

With `DATABASE_URL` set this creates the user in that database instead (e.g. Neon in production).

To receive real GitHub webhooks locally, expose the port (e.g. `cloudflared tunnel --url localhost:3000`) and set `PUBLIC_BASE_URL` to the tunnel URL.

## Deploy (Vercel + Neon)

1. In Neon → Connect, copy both connection strings: the **direct** one and the **pooled** one (host contains `-pooler`).
2. Run migrations once from your machine against the direct URL: `DATABASE_URL='postgresql://...' npm run db:migrate`
3. In Vercel, import the repo and set env vars: `DATABASE_URL_POOLED` (the pooled URL), `DATABASE_URL` (the direct URL), and optionally `PUBLIC_BASE_URL`. The server uses `DATABASE_URL_POOLED` when it's set.
4. Deploy. Vercel picks up `src/index.ts` as a Hono app automatically.
5. Create users from your machine: `DATABASE_URL='postgresql://...' npm run user:create -- --name Matthew`

Tables live in a `loopway` schema (not `public`) with RLS enabled and no policies, so a Data API (Neon's is opt-in) can't reach them.

## API

Users are created with `npm run user:create` (see above). Every endpoint except `/webhooks/*`, `/health` and `/` takes `Authorization: Bearer <api_key>`.
Errors look like `{ "error": { "code": "...", "message": "..." } }`.

### Users

| | |
|---|---|
| `GET /me` | Current user. |
| `POST /me/api-key` | Rotate key. Old key stops working immediately. |

### Inboxes

| | |
|---|---|
| `GET /sources` | Available source types. |
| `POST /inboxes` `{name, source_type, config?}` | Create. Response includes `webhook_url` and `setup` instructions. |
| `GET /inboxes` | List yours. |
| `GET /inboxes/:id` | One inbox + `stats` (`pending`/`locked`/`processed` counts). |
| `PATCH /inboxes/:id` `{name?, config?}` | Update. Config merges onto existing (secret kept unless given). |
| `DELETE /inboxes/:id` | Deletes the inbox and its events. |

**`github` config:** `{ "secret"?: string (≥16 chars, generated if omitted), "events"?: ["push", "pull_request", ...] (default ["*"]) }`

In GitHub → Settings → Webhooks: Payload URL = `webhook_url`, Content type = `application/json`, Secret = `config.secret`.

### Webhook ingestion

`POST /webhooks/:inboxId` — no API key; authenticated by the source (GitHub: `X-Hub-Signature-256` HMAC).

- `202 {id, duplicate:false}` stored
- `200 {id, duplicate:true}` redelivery of an event already stored (same CloudEvent `source`+`id`)
- `200 {ignored:true, reason}` `ping`, or an event type not in `config.events`
- `401` bad/missing signature · `404` unknown inbox

GitHub → CloudEvent mapping follows the [CloudEvents GitHub adapter spec](https://github.com/cloudevents/spec/blob/main/cloudevents/adapters/github.md): `id` = `X-GitHub-Delivery`, `type` = `com.github.<event>.<action>`, `source`/`subject`/`time` per event, `data` = payload.

### Events

All under `/inboxes/:inboxId/events`.

| | |
|---|---|
| `GET /` | List. Query: `status` = `all` (default) \| `pending` \| `locked` \| `processed` \| `unprocessed`; `type` (exact, or prefix with trailing `*`, e.g. `com.github.pull_request.*`); `limit` (≤100, default 50); `order` = `asc` \| `desc`; `cursor` = `next_cursor` from the previous page. |
| `GET /:eventId` | One event. |
| `POST /next` `{ttl_seconds?}` | Claim the oldest pending event with a lock. `200` with event + `lock`, or `204` if nothing's available. Safe with concurrent consumers. |
| `POST /:eventId/lock` `{ttl_seconds?, lock_token?}` | Lock a specific event. Pass your current `lock_token` to extend it. `409 locked` if someone else holds it. |
| `POST /:eventId/unlock` `{lock_token}` | Release the lock; event goes back to `pending`. |
| `POST /:eventId/processed` `{lock_token?}` | Mark done. Token required only if a live lock exists. Idempotent. |

`ttl_seconds` defaults to 300, max 43200. Locks expire on their own, so a crashed consumer's event becomes claimable again.

Event shape:

```json
{
  "id": "0192…",                       // loopway id (UUIDv7, time-ordered)
  "inbox_id": "0192…",
  "status": "locked",                  // pending | locked | processed
  "received_at": "2026-10-04T23:40:00.000Z",
  "locked_until": "2026-10-04T23:45:00.000Z",
  "processed_at": null,
  "lock_count": 1,                     // times it has been claimed
  "lock": { "token": "lk_…", "expires_at": "…" },   // only on next/lock responses
  "event": {                           // the CloudEvent, structured mode
    "specversion": "1.0",
    "id": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    "source": "https://api.github.com/repos/craftmill/loopway",
    "type": "com.github.pull_request.opened",
    "subject": "42",
    "time": "2026-10-04T23:39:58.000Z",
    "datacontenttype": "application/json",
    "data": { "...": "GitHub payload" }
  }
}
```

### Consumer loop

```bash
API=http://localhost:3000; KEY=lw_...; INBOX=...
while :; do
  ev=$(curl -s -X POST "$API/inboxes/$INBOX/events/next" -H "authorization: Bearer $KEY")
  [ -z "$ev" ] && { sleep 5; continue; }
  # ... handle "$ev" ...
  curl -s -X POST "$API/inboxes/$INBOX/events/$(jq -r .id <<<"$ev")/processed" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d "{\"lock_token\":\"$(jq -r .lock.token <<<"$ev")\"}" >/dev/null
done
```

## Layout

```
src/index.ts            Vercel entry (default-exports the Hono app)
src/api.ts              routes, auth, serialization
src/store.ts            all SQL
src/db/                 driver adapter (PGlite | postgres.js) + migrations
src/sources/            source adapters; github.ts is the first
src/cloudevents.ts      CloudEvent type + validation
scripts/                dev server, migrate, create-user
test/api.test.ts        end-to-end tests (TEST_DATABASE_URL=... to run against real Postgres)
```

### Adding a source

Implement `SourceAdapter` (`src/sources/types.ts`): `parseConfig` (validate + defaults), `publicConfig`, optional `setup`, and `receive(headers, rawBody) → event | ignored | rejected`. Register it in `src/sources/index.ts`.
