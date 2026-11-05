# API

The `loopway` server is a plain HTTP API; the [CLI](../README.md#cli) is a client of it. This file is the contract.

Every route below is served under `/api` (the paths here include it); the landing page and static assets live outside it.

Users are created with `loopway login`. Every endpoint except `/api/webhooks/*`, `/api/cron/tick`, `/api/auth/*`, `/api/health`, `/api` and the landing page takes `Authorization: Bearer <token>`. The token is a session JWT from `loopway login`, valid 30 days, or an API token from `POST /api/tokens`, which starts `lw_` and lasts until it's revoked.

Errors look like `{ "error": { "code": "...", "message": "..." } }`. A CLI older than the server's minimum gets `426 cli_outdated`.

## Users

|                                     |                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login` `{email}`        | Email an 8-character code (valid 10 min) via Resend. `202`. With `SIGNUPS=closed`, an email with no user gets `403 signups_closed`. At most one email per address per 10 minutes; asking again sooner sends nothing.                                    |
| `POST /api/auth/verify` `{email, code, username?}` | Trade the code for a session token (`201 {token, expires_at, user, created}`). Single use, 5 guesses. If the email has no user yet, `username` is required and creates the user, named after it. Without it: `400 username_required`; a bad one: `400 invalid_username` / `username_reserved`, `409 username_taken`. These leave the code valid (and spend no guess) so the call can be repeated. Existing users ignore `username`. With `SIGNUPS=closed`, an email with no user gets `403 signups_closed`. |
| `GET /api/me` | Current user, with `username` (null only for accounts made before signup required one). |
| `PATCH /api/me/username` `{username}` | Set or change the username. Lowercase `[a-z0-9-]`, 2-39 chars, no leading/trailing `-`, not reserved. `400 invalid_username` / `username_reserved`, `409 username_taken`. |
| `GET /api/usernames/:username` | `{username, available, reason?, message?}`: whether the name can be used (your own current one counts as available). |

## API tokens

|                            |                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /api/tokens`          | `{data: [{id, name, created_at, last_used_at}]}`. `last_used_at` is updated at most once an hour.                     |
| `POST /api/tokens` `{name}` | `201`, with `token`. This is the only response that carries it: only its hash is stored. It works like a session token. |
| `DELETE /api/tokens/:id`   | Revokes it. `204`.                                                                                                    |

## The inbox

`GET /api/inbox` returns `{url, sources, messages, retention_days}`. `url` is what every sender is given. It's `/api/webhooks/<user id>`, so changing your username doesn't change it.

## Sources

A source is something the inbox accepts: a sender's signing secret, or a schedule. Each one's setup in the sender and how its deliveries map to CloudEvents are in `docs/sources/`: [github](sources/github.md), [vercel](sources/vercel.md), [linear](sources/linear.md), [granola](sources/granola.md), [resend](sources/resend.md), [loopway](sources/loopway.md) and [schedule](sources/schedule.md).

|                                                  |                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/source-types`                          | `{data, schedule_options}`. For each type: `type`, `label`, `description`, who makes the `secret` (`{from: "loopway", min_length}`, `{from: "sender"}` or `{from: "none"}`), and `webhook_settings` (where the webhook is added in the sender).                                                                         |
| `GET /api/sources`                               | `{data: [source]}`.                                                                                                                                                                                                                                                                                                     |
| `POST /api/sources` `{type, name?, secret?, config?}` | Registers one. `name` defaults to the type, and is unique per user: `409 source_name_taken`. Where loopway makes the secret and none is given, the `201` carries it as `secret`, the only time it's shown. It's stored encrypted and never readable again. `config` is only for `schedule`. A user can have up to 50: `409 too_many_sources`. |
| `GET /api/sources/:id`                           | One source.                                                                                                                                                                                                                                                                                                             |
| `PATCH /api/sources/:id` `{name?, secret?, config?}` | Update. A new `secret` replaces the old one.                                                                                                                                                                                                                                                                       |
| `DELETE /api/sources/:id`                        | Removes it. Its deliveries are refused from then on. Messages it sent stay until they expire, with `source_id: null`.                                                                                                                                                                                                  |

A source looks like `{id, name, type, config?, secret_set?, webhook_url?, webhook_settings, created_at, last_delivery_at, last_delivery_outcome}`. `secret_set` and `webhook_url` are missing from a schedule, and `config` from anything else. `last_delivery_at` and `last_delivery_outcome` (`accepted` or `ignored:<reason>`) only change for a delivery that verifies: the inbox URL is public, so a refused one could be from anyone.

## Webhook ingestion

`POST /api/webhooks/:userId` takes no API token. It's authenticated by the sender's signature, or by a source's bearer token for `loopway` sources.

Each source of the user whose sender claims the delivery (by its signature header) is tried in turn, so a user can have several of one type. The first that verifies it stores it, under that source.

- `202 {id, duplicate:false}` stored
- `200 {id, duplicate:true}` redelivery of a message already stored (same CloudEvent `source`+`id`)
- `200 {ignored:true, reason}` a verified delivery with nothing to store, like GitHub's `ping`
- `400` malformed body · `401` no source verifies it, and nothing is stored · `404` unknown user · `415` unsupported content type

## Messages

A message is a stored delivery. It has no status, and nothing marks one done. It's dropped from every read 14 days after it arrives, and deleted by the daily cron.

```json
{
  "id": "0192…", // loopway's id for the message
  "source_id": "0192…", // the source that verified it; null if pushed, or if the source was removed
  "received_at": "2026-10-04T23:40:00.123456Z", // to the microsecond
  "received_us": "1791157200123456", // the same time as microseconds since the epoch, as a string
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

### Reading

`GET /api/messages` returns `{data, next_since, next_after, has_more}`, oldest first, ordered by `(received_at, id)`.

| Query   |                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `since` | Where to start, inclusive: microseconds since the epoch, an ISO 8601 time with up to six fractional digits, or `now`. Left out, the oldest message still held. Anything else: `400 invalid_since`. |
| `after` | The `next_after` from the last page. Only with the `since` it came with.                                                                                              |
| `limit` | ≤100, default 50.                                                                                                                                                     |
| `type`  | Exact, or a prefix with a trailing `*`, e.g. `com.github.pull_request.*`.                                                                                             |

To read everything, pass `next_since` and `next_after` back until `has_more` is false, and keep them for next time.

- **Delivery is at least once.** Nothing on the server tracks a reader. Whoever holds the cursor decides when it moves, so a crash means a repeat, not a loss. Going back is a matter of asking for an earlier `since`.
- `after` is what makes paging exact. Two messages can share a microsecond, so `since` alone can't say where a page ended.
- `since=now` returns no messages and the `next_since` a new reader should start from.
- Reads stop 5 seconds behind the clock. A message's time is set when its insert runs, but the row is only visible once it commits, so without this a reader could move past a message that hadn't appeared yet. Read to the end, `next_since` is that 5-second mark and `next_after` is null. A message with exactly that time comes next.

`GET /api/messages?order=desc` returns the newest messages first, for looking at an inbox. It takes `limit` and `type`, has no holdback, and gives no cursor: `since` or `after` with it is a `400`.

`GET /api/messages/:id` returns one message, or `404` once it's past retention.

### Pushing

`POST /api/messages` `{type, subject?, id?, data?}` puts a message in your own inbox as a CloudEvent with source `urn:loopway:push`. `id` is its CloudEvent id: pushing the same `id` again stores nothing new and answers `200 {id, duplicate:true}`. Without one, each push is a new message. `202 {id, duplicate:false}` otherwise. `data` is any JSON, at most 1 MiB: `400 too_large`.

## MCP

`POST /api/mcp` is a stateless MCP server over Streamable HTTP: one JSON-RPC message per request, a JSON answer, no sessions and no stream (`GET` and `DELETE` are `405`). It takes the same bearer tokens as the API, and always acts on the caller's own inbox.

- `push_message` `{type, subject?, id?, data?}`: the same as `POST /api/messages`.
- `pull_messages` `{since?, after?, limit?, type?}`: the same as `GET /api/messages`.

Each returns its JSON as text. Bad input is a tool result with `isError: true`, with a message the agent can act on.

## Cron

`GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` is what Vercel Cron calls. It fills schedule sources and deletes messages past retention, and returns `{sources, accepted, duplicate, failed, disabled, purged}`.
