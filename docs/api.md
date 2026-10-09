# API

The `loopway` server is a plain HTTP API; the [CLI](../README.md#cli) is a client of it. This file is the contract.


Users are created with `loopway login` (or the web UI). Every endpoint except `/webhooks/*`, `/health`, `/api` and the web pages takes `Authorization: Bearer <token>`. The token is a session JWT from `loopway login`, valid 30 days.
Errors look like `{ "error": { "code": "...", "message": "..." } }`.

## Users

|                                     |                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login` `{email}`        | Email an 8-character code (valid 10 min) via Resend. Always `202`. At most one email per address per 10 minutes; asking again sooner sends nothing.                                    |
| `POST /auth/verify` `{email, code}` | Trade the code for a session token (`201 {token, expires_at, user, created}`). Single use, 5 guesses. If the email has no user yet, creates one (named after the part before the `@`). |
| `GET /me`                           | Current user.                                                                                                                                                                          |

## Inboxes

|                                                |                                                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /sources`                                 | Available source types: `type`, `label`, `description`, common `events`, who makes the `secret` (`{from: "loopway", min_length}` or `{from: "sender"}`), and `webhook_settings` (where the webhook is added in the sender). |
| `POST /inboxes` `{name, source_type, config?}` | Create. Response includes `webhook_url` and `setup` instructions.                                                                                                                                                           |
| `GET /inboxes`                                 | List yours.                                                                                                                                                                                                                 |
| `GET /inboxes/:id`                             | One inbox + `stats` (`pending`/`locked`/`processed` counts).                                                                                                                                                                |
| `PATCH /inboxes/:id` `{name?, config?}`        | Update. Config merges onto existing (secret kept unless given).                                                                                                                                                             |
| `DELETE /inboxes/:id`                          | Deletes the inbox and its events.                                                                                                                                                                                           |

**`github` config:** `{ "secret"?: string (≥16 chars, generated if omitted), "events"?: ["push", "pull_request", ...] (default ["*"]) }`

In GitHub → Settings → Webhooks: Payload URL = `webhook_url`, Content type = `application/json`, Secret = `config.secret`.

**`vercel` config:** `{ "secret"?: string, "events"?: ["deployment.error", ...] (default ["*"]) }`. `config.secret` is `null` until set.

In Vercel → Team Settings → Webhooks: Endpoint URL = `webhook_url`. Vercel shows a secret once the webhook is created; `PATCH` it into `config.secret`. Until then deliveries get `401`.

**`granola` config:** `{ "secret"?: "whsec_…", "events"?: ["note.generated", "note.edited", "note.access_granted"] (default ["*"]) }`. `config.secret` is `null` until set.

Granola webhooks need a Business or Enterprise plan. Granola generates the signing secret after it has the URL, so:

1. `loopway inbox create --name notes --source granola` and copy its `webhook_url`.
2. In the Granola desktop app: Settings → Connectors → Webhooks → Set up a webhook (or a folder → Integrations → Webhooks for one folder). Paste the URL.
3. Copy the `whsec_…` secret Granola shows (only once) and run `loopway inbox update notes --secret whsec_…`, or paste it on the inbox's dashboard page. Until then the inbox answers `401`, and Granola drops those deliveries without retrying.
4. Record a meeting, or edit a note's summary, and check `loopway events list notes`.

Each event only carries `note_id`; fetch the note itself with a Granola API key (Settings → Connectors → API keys): `curl -H "Authorization: Bearer grn_…" <event source>`.

**`loopway` config:** `{ "secret"?: string (≥16 chars, generated if omitted), "events"?: ["build.finished", ...] (default ["*"]), "schema"?: JSON Schema }`. Bots and backends use these inboxes to send each other messages. The secret is the inbox token they send as a bearer token. `schema` is a JSON Schema (2020-12) every message must match; its `required` must include `type`, `id` and `data`, and the default, `{"type": "object", "required": ["type", "id", "data"]}`, accepts any values for them. Set it with `loopway inbox create --schema schema.json` or `loopway inbox update <inbox> --schema schema.json`.

```sh
curl -X POST <webhook_url> \
  -H "Authorization: Bearer <inbox token>" \
  -H "Content-Type: application/json" \
  -d '{"type": "build.finished", "id": "build-42", "data": {"ok": true}}'
```

## Webhook ingestion

`POST /webhooks/:inboxId` — no API key; authenticated by the source (GitHub: `X-Hub-Signature-256` HMAC-SHA256; Vercel: `X-Vercel-Signature` HMAC-SHA1; Granola: Standard Webhooks `webhook-signature`, timestamp within 5 minutes; Loopway: `Authorization: Bearer <inbox token>`).

- `202 {id, duplicate:false}` stored
- `200 {id, duplicate:true}` redelivery of an event already stored (same CloudEvent `source`+`id`)
- `200 {ignored:true, reason}` `ping`
- `400` malformed body (for Loopway, one that doesn't match the inbox schema) · `401` bad/missing signature or token (or, for Vercel and Granola, no secret set yet) · `404` unknown inbox · `415` unsupported content type · `422` event type not in `config.events` (GitHub shows it as a failed delivery and doesn't retry it; Vercel retries any non-2xx for up to 24 hours; Granola retries only 408, 429 and 5xx)

GitHub → CloudEvent mapping follows the [CloudEvents GitHub adapter spec](https://github.com/cloudevents/spec/blob/main/cloudevents/adapters/github.md): `id` = `X-GitHub-Delivery`, `type` = `com.github.<event>.<action>`, `source`/`subject`/`time` per event, `data` = payload.

Vercel → CloudEvent: `id` = body `id`, `type` = `com.vercel.<type>` (e.g. `com.vercel.deployment.error`), `source` = the project's API URL (`https://api.vercel.com/v9/projects/<id>`, else the team's), `subject` = what the event is about (the deployment id for `deployment.*`, the project id for `project.*`, the domain name for `domain.*`, …, else the event id, so every event has one), `time` = `createdAt`, `data` = the whole body.

Granola → CloudEvent: `id` = `webhook-id`, `type` = `ai.granola.<event_type>` (e.g. `ai.granola.note.generated`), `source` = `https://public-api.granola.ai/v1/notes/<note_id>`, `subject` = `note_id`, `time` = `occurred_at`, `data` = payload.

Loopway → CloudEvent: `id` = a new UUID per message (so nothing is deduped), `type` = body `type` (a non-empty string), `source` = the inbox's webhook URL, `subject` = `<type>/<id>` with body `id` (a string or number naming what the message is about, so every message about it shares a subject), `time` = receive time, `data` = body `data`.

## Events

All under `/inboxes/:inboxId/events`.

|                                                     |                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                             | List. Query: `status` = `all` (default) \| `pending` \| `locked` \| `processed` \| `unprocessed`; `type` (exact, or prefix with trailing `*`, e.g. `com.github.pull_request.*`); `limit` (≤100, default 50); `order` = `asc` \| `desc`; `cursor` = `next_cursor` from the previous page. |
| `GET /:eventId`                                     | One event.                                                                                                                                                                                                                                                                               |
| `POST /next` `{ttl_seconds?}`                       | Claim the oldest pending event with a lock. `200` with event + `lock`, or `204` if nothing's available. Safe with concurrent consumers.                                                                                                                                                  |
| `POST /:eventId/lock` `{ttl_seconds?, lock_token?}` | Lock a specific event. Pass your current `lock_token` to extend it. `409 locked` if someone else holds it.                                                                                                                                                                               |
| `POST /:eventId/unlock` `{lock_token}`              | Release the lock; event goes back to `pending`.                                                                                                                                                                                                                                          |
| `POST /:eventId/processed` `{lock_token?}`          | Mark done. Token required only if a live lock exists. Idempotent.                                                                                                                                                                                                                        |

`ttl_seconds` defaults to 300, max 43200. Locks expire on their own, so a crashed consumer's event becomes claimable again.

Event shape:

```json
{
  "id": "0192…", // loopway id (UUIDv7, time-ordered)
  "inbox_id": "0192…",
  "seq": 1234, // arrival order across all inboxes, assigned by the database; bots read by it
  "status": "locked", // pending | locked | processed
  "received_at": "2026-10-04T23:40:00.000Z",
  "locked_until": "2026-10-04T23:45:00.000Z",
  "processed_at": null,
  "lock_count": 1, // times it has been claimed
  "lock": { "token": "lk_…", "expires_at": "…" }, // only on next/lock responses
  "event": {
    // the CloudEvent, structured mode
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

## Consumer loop

```bash
API=http://localhost:3000; KEY=<token>; INBOX=...
while :; do
  ev=$(curl -s -X POST "$API/inboxes/$INBOX/events/next" -H "authorization: Bearer $KEY")
  [ -z "$ev" ] && { sleep 5; continue; }
  # ... handle "$ev" ...
  curl -s -X POST "$API/inboxes/$INBOX/events/$(jq -r .id <<<"$ev")/processed" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d "{\"lock_token\":\"$(jq -r .lock.token <<<"$ev")\"}" >/dev/null
done
```

## Bots

A bot reads the messages (events) of one or more of your inboxes, in `seq` order, and keeps a `cursor`: the `seq` of the last message it has read past. A runner (`loopway bots run`) takes a lease on the bot while it reads, so only one runner at a time moves the cursor.

|                                                    |                                                                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /bots` `{name, kind, inbox_ids}`             | Create. `kind` is any string; the CLI only accepts kinds it can run (`github-threads`). The `cursor` starts at the newest message in its inboxes, so a new bot doesn't replay history.         |
| `GET /bots`                                        | List yours.                                                                                                                                                                                     |
| `GET /bots/:id`                                    | One bot.                                                                                                                                                                                        |
| `PATCH /bots/:id` `{name?, inbox_ids?}`            | Update. `inbox_ids` replaces the bot's inboxes; the cursor stays where it is.                                                                                                                   |
| `DELETE /bots/:id`                                 | Delete. The row is kept with `deleted_at` set, but the API no longer returns it. Deleting an inbox also removes it from its bots.                                                                                |
| `GET /bots/:id/messages` `?limit=`                 | Messages in the bot's inboxes with `seq > cursor`, oldest first (`limit` ≤100, default 50). Messages received in the last 5 seconds, and anything after them, are held back (see below).       |
| `POST /bots/:id/lease` `{ttl_seconds?, lease_token?}` | Take the bot's lease, or renew it by passing your current token. Returns `{lease: {token, expires_at}}`. `409 leased` while another runner holds a live lease. Same TTL rules as event locks. |
| `POST /bots/:id/release` `{lease_token}`           | Drop the lease, so the next runner needn't wait out the TTL. `409 lease_mismatch` if the token isn't the live lease, `409 not_leased` if there is none.                                        |
| `POST /bots/:id/cursor` `{seq, lease_token}`       | Move the cursor forward to `seq`; it never moves backwards. Returns the bot. `409` if the token isn't the live lease.                                                                          |

`inbox_ids` must be your inboxes. Bot shape: `{id, name, kind, inbox_ids, cursor, created_at}`; the lease is never part of it.

Two webhooks landing at once can commit out of `seq` order, and a cursor that had moved past the later one would skip the earlier. So `messages` stops at the first message received in the last few seconds, giving inserts still in flight time to land.

