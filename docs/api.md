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
| `GET /sources`                                 | Available source types: `type`, `label`, `description`, common `events`, who makes the `secret` (`{from: "loopway", min_length}` or `{from: "sender"}`), and `webhook_settings` (where the webhook is added in the sender). `can_request` says whether this deployment takes source requests. |
| `POST /sources/requests` `{description}` | Ask for a source type loopway doesn't have. Posts a `source.requested` message (the description and the asker's user id) to the deployment's requests inbox. `202`; `404` where requests are off. |
| `POST /inboxes` `{name, source_type, config?}` | Create. Response includes `webhook_url` and `setup` instructions.                                                                                                                                                           |
| `GET /inboxes`                                 | List yours.                                                                                                                                                                                                                 |
| `GET /inboxes/:id`                             | One inbox + `stats` (`{events}`: how many it holds).                                                                                                                                                                        |
| `PATCH /inboxes/:id` `{name?, config?}`        | Update. Config merges onto existing (secret kept unless given).                                                                                                                                                             |
| `DELETE /inboxes/:id`                          | Deletes the inbox and its events.                                                                                                                                                                                           |

Each source's `config`, how to connect it in the sender, and how its deliveries map to CloudEvents are in `docs/sources/`: [github](sources/github.md), [vercel](sources/vercel.md), [granola](sources/granola.md) and [loopway](sources/loopway.md).

## Webhook ingestion

`POST /webhooks/:inboxId` — no API key; authenticated by the source: a signature header, or a bearer token for `loopway` inboxes (see each source's doc).

- `202 {id, duplicate:false}` stored
- `200 {id, duplicate:true}` redelivery of an event already stored (same CloudEvent `source`+`id`)
- `200 {ignored:true, reason}` `ping`
- `400` malformed body (for Loopway, one that doesn't match the inbox schema) · `401` bad/missing signature or token (or, for Vercel and Granola, no secret set yet) · `404` unknown inbox · `415` unsupported content type · `422` event type not in `config.events` (GitHub shows it as a failed delivery and doesn't retry it; Vercel retries any non-2xx for up to 24 hours; Granola retries only 408, 429 and 5xx)


## Events

All under `/inboxes/:inboxId/events`. An event is a stored message: there's no per-event status, and nothing marks one done. Bots keep their place with a cursor (see [Bots](#bots)).

|                |                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`        | List. Query: `type` (exact, or prefix with trailing `*`, e.g. `com.github.pull_request.*`); `limit` (≤100, default 50); `order` = `asc` (default) \| `desc`; `cursor` = `next_cursor` from the previous page. |
| `GET /:eventId` | One event.                                                                                                                                                                                                        |

Event shape:

```json
{
  "id": "0192…", // loopway id (UUIDv7, time-ordered)
  "inbox_id": "0192…",
  "seq": 1234, // arrival order across all inboxes, assigned by the database; bots read by it
  "received_at": "2026-10-04T23:40:00.000Z",
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
| `POST /bots/:id/lease` `{ttl_seconds?, lease_token?}` | Take the bot's lease, or renew it by passing your current token. Returns `{lease: {token, expires_at}}`. `409 leased` while another runner holds a live lease, with `details.expires_at` saying until when. `ttl_seconds` defaults to 300, max 43200. |
| `POST /bots/:id/release` `{lease_token?, force?}`  | Drop the lease, so the next runner needn't wait out the TTL. `409 lease_mismatch` if the token isn't the live lease, `409 not_leased` if there is none. `force: true` drops whoever's lease, no token needed: for a runner that died without releasing. |
| `POST /bots/:id/cursor` `{seq, lease_token}`       | Move the cursor forward to `seq`; it never moves backwards. Returns the bot. `409` if the token isn't the live lease.                                                                          |

`inbox_ids` must be your inboxes. Bot shape: `{id, name, kind, inbox_ids, cursor, created_at}`; the lease is never part of it.

Two webhooks landing at once can commit out of `seq` order, and a cursor that had moved past the later one would skip the earlier. So `messages` stops at the first message received in the last few seconds, giving inserts still in flight time to land.

