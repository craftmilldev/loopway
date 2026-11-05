# API

The `loopway` server is a plain HTTP API; the [CLI](../README.md#cli) is a client of it. This file is the contract.


Every route below is served under `/api` (the paths here include it); the web pages and static assets live outside it, and the old top-level paths (`/inboxes`, `/auth/login`, ...) answer `404`.

Users are created with `loopway login` (or the web UI). Every endpoint except `/api/webhooks/*`, `/api/health`, `/api` and the web pages takes `Authorization: Bearer <token>`. The token is a session JWT from `loopway login`, valid 30 days.
Errors look like `{ "error": { "code": "...", "message": "..." } }`.

## Users

|                                     |                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login` `{email}`        | Email an 8-character code (valid 10 min) via Resend. `202`. With `SIGNUPS=closed`, an email with no user gets `403 signups_closed`. At most one email per address per 10 minutes; asking again sooner sends nothing.                                    |
| `POST /api/auth/verify` `{email, code, username?}` | Trade the code for a session token (`201 {token, expires_at, user, created}`). Single use, 5 guesses. If the email has no user yet, `username` is required and creates the user, named after it. Without it: `400 username_required`; a bad one: `400 invalid_username` / `username_reserved`, `409 username_taken`. These leave the code valid (and spend no guess) so the call can be repeated. Existing users ignore `username`. With `SIGNUPS=closed`, an email with no user gets `403 signups_closed`. |
| `GET /api/me` | Current user, with `username` (null only for accounts made before signup required one). |
| `PATCH /api/me/username` `{username}` | Set or change the username. Lowercase `[a-z0-9-]`, 2-39 chars, no leading/trailing `-`, not reserved. `400 invalid_username` / `username_reserved`, `409 username_taken`. |
| `GET /api/usernames/:username` | `{username, available, reason?, message?}`: whether the name can be used (your own current one counts as available). |

## Inboxes

|                                                |                                                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/sources`                                 | Available source types: `type`, `label`, `description`, common `events`, who makes the `secret` (`{from: "loopway", min_length}`, `{from: "sender"}`, or `{from: "none"}` for a source that takes no webhooks), and `webhook_settings` (where the webhook is added in the sender). |
| `POST /api/inboxes` `{name, source_type, config?}` | Create. Response includes `webhook_url` and `setup` instructions, and is the only one that carries the inbox's webhook secret (`config.secret`). It is stored encrypted and never readable again; every other response has `config.secret_set` instead.                                                                                                                                                           |
| `GET /api/inboxes`                                 | List yours.                                                                                                                                                                                                                 |
| `GET /api/inboxes/:id`                             | One inbox + `stats` (`{messages}`: how many it holds).                                                                                                                                                                        |
| `PATCH /api/inboxes/:id` `{name?, config?}`        | Update. Config merges onto existing (secret kept unless given; a new one is not echoed back).                                                                                                                                                             |
| `DELETE /api/inboxes/:id`                          | Deletes the inbox and its messages.                                                                                                                                                                                           |

Each source's `config`, how to connect it in the sender, and how its deliveries map to CloudEvents are in `docs/sources/`: [github](sources/github.md), [vercel](sources/vercel.md), [linear](sources/linear.md), [granola](sources/granola.md), [resend](sources/resend.md), [loopway](sources/loopway.md) and [schedule](sources/schedule.md).

## Webhook ingestion

`POST /api/webhooks/:inboxId` — no API key; authenticated by the source: a signature header, or a bearer token for `loopway` inboxes (see each source's doc).

- `202 {id, duplicate:false}` stored
- `200 {id, duplicate:true}` redelivery of a message already stored (same CloudEvent `source`+`id`)
- `200 {ignored:true, reason}` `ping`, or for Granola a signed delivery with no `note_id`
- `400` malformed body (for Loopway, one that doesn't match the inbox schema) · `401` bad/missing signature or token (or, for Vercel, Granola and Resend, no secret set yet) · `404` unknown inbox · `415` unsupported content type · `422` event type not in `config.events` (GitHub shows it as a failed delivery and doesn't retry it; Vercel retries any non-2xx for up to 24 hours; Granola retries only 408, 429 and 5xx)

## Sending a test message

`POST /api/inboxes/:id/test` `{from?}` — session auth; it must be your inbox (`404` otherwise). It builds a small sample event for the inbox's source, signs it with the inbox's stored secret the way the sender would, and runs it through the same handler as `POST /api/webhooks/:inboxId`, so it is stored like any message. `201 {message_id, seq}`. Each call stores a new message.

- The message is stored with `is_test` set, and `GET /api/inboxes/:id/messages` returns it as `test: true` (`false` for every other message). The CloudEvent itself is the sample, unmarked. Only this route sets it: no webhook can.
- If the inbox's `events` filter rejects the sample's type, the first sample type the inbox accepts is sent instead. If it accepts none: `422 no_accepted_type`.
- For a source whose sender makes the secret (Linear, Vercel, Granola, Resend) that hasn't been pasted in yet: `409 secret_not_set`.
- A sample the inbox refuses anyway (a `loopway` inbox whose schema the sample doesn't match) answers what the webhook would: `400` or `422`.
- `from` (default `cli`) only labels the `test_message_sent` / `test_message_failed` metric events.

From the CLI: `loopway inbox test <inbox>`.

## Messages

All under `/api/inboxes/:inboxId/messages`. A message is a stored delivery: there's no per-message status, and nothing marks one done.

|                |                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`        | List. Query: `type` (exact, or prefix with trailing `*`, e.g. `com.github.pull_request.*`); `limit` (≤100, default 50); `order` = `asc` (default) \| `desc`; `cursor` = `next_cursor` from the previous page. |
| `GET /:messageId` | One message.                                                                                                                                                                                                        |

Message shape:

```json
{
  "id": "0192…", // loopway id (UUIDv7, time-ordered)
  "inbox_id": "0192…",
  "seq": 1234, // arrival order across all inboxes, assigned by the database
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
