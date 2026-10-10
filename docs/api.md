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
| `GET /inboxes/:id`                             | One inbox + `stats` (`{messages}`: how many it holds).                                                                                                                                                                        |
| `PATCH /inboxes/:id` `{name?, config?}`        | Update. Config merges onto existing (secret kept unless given).                                                                                                                                                             |
| `DELETE /inboxes/:id`                          | Deletes the inbox and its messages.                                                                                                                                                                                           |

Each source's `config`, how to connect it in the sender, and how its deliveries map to CloudEvents are in `docs/sources/`: [github](sources/github.md), [vercel](sources/vercel.md), [granola](sources/granola.md) and [loopway](sources/loopway.md).

## Webhook ingestion

`POST /webhooks/:inboxId` — no API key; authenticated by the source: a signature header, or a bearer token for `loopway` inboxes (see each source's doc).

- `202 {id, duplicate:false}` stored
- `200 {id, duplicate:true}` redelivery of a message already stored (same CloudEvent `source`+`id`)
- `200 {ignored:true, reason}` `ping`
- `400` malformed body (for Loopway, one that doesn't match the inbox schema) · `401` bad/missing signature or token (or, for Vercel and Granola, no secret set yet) · `404` unknown inbox · `415` unsupported content type · `422` event type not in `config.events` (GitHub shows it as a failed delivery and doesn't retry it; Vercel retries any non-2xx for up to 24 hours; Granola retries only 408, 429 and 5xx)


## Messages

All under `/inboxes/:inboxId/messages`. A message is a stored delivery: there's no per-message status, and nothing marks one done. Bots keep their place with a cursor (see [Bots](#bots)).

|                |                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`        | List. Query: `type` (exact, or prefix with trailing `*`, e.g. `com.github.pull_request.*`); `limit` (≤100, default 50); `order` = `asc` (default) \| `desc`; `cursor` = `next_cursor` from the previous page. |
| `GET /:messageId` | One message.                                                                                                                                                                                                        |

Message shape:

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

## Runners

A runner is a machine running loopway. The CLI makes its id (kept in `~/.loopway/runner.json`) and registers it on startup. A process leases its runner while it runs, so only one process uses a runner id at a time. A bot lease records which runner holds it, and a thread belongs to the runner that claimed it (see [Threads](#threads)).

| Endpoint | |
| --- | --- |
| `POST /runners` `{id, name}` | Register the runner, or rename it and mark it seen; safe to repeat. `409 runner_exists` if the id is another user's. |
| `POST /runners/:id/lease` `{ttl_seconds?, lease_token?}` | Take the runner's lease, or renew it by passing your current token. Returns `{lease: {token, expires_at}}`. `409 runner_leased` while another process holds a live lease, with `details.expires_at`. `ttl_seconds` defaults to 300, max 43200. |
| `POST /runners/:id/release` `{lease_token?, force?}` | Drop the lease. `409 runner_lease_mismatch` if the token isn't the live lease. `force: true` drops whoever's, for a process that died without releasing. |
| `GET /runners` | Your runners: `{id, name, created_at, last_seen_at, leased_until, bots, threads}`. `leased_until` is null unless a process holds the lease, `bots` is `[{id, name}]` for the bot leases it holds now, and `threads` counts the threads it owns. The lease token is never part of it. |

## Bots

A bot reads the messages of one or more of your inboxes, in `seq` order, and keeps a `cursor`: the `seq` of the last message it has read past. A runner (`loopway bots run`) takes a lease on the bot while it reads, so only one runner at a time moves the cursor.

|                                                    |                                                                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /bots` `{name, kind, model, inbox_ids}`             | Create. `model` is one of the aliases or ids in `packages/web/src/models.ts` (`sonnet`, `opus`, `claude-sonnet-5-5`, ...), else `400`; every session the bot runs uses it. `kind` is any string; the CLI only accepts kinds it can run (`github-threads`). The `cursor` starts at the newest message in its inboxes, so a new bot doesn't replay history.         |
| `GET /bots`                                        | List yours.                                                                                                                                                                                     |
| `GET /bots/:id`                                    | One bot.                                                                                                                                                                                        |
| `PATCH /bots/:id` `{name?, model?, inbox_ids?}`            | Update. `inbox_ids` replaces the bot's inboxes; the cursor stays where it is.                                                                                                                   |
| `DELETE /bots/:id`                                 | Delete. The row is kept with `deleted_at` set, but the API no longer returns it. Deleting an inbox also removes it from its bots.                                                                                |
| `GET /bots/:id/messages` `?limit=`                 | Messages in the bot's inboxes with `seq > cursor`, oldest first (`limit` ≤100, default 50). Messages received in the last 5 seconds, and anything after them, are held back (see below).       |
| `POST /bots/:id/lease` `{ttl_seconds?, lease_token?, runner_id?}` | Take the bot's lease, or renew it by passing your current token. `runner_id` records the holder (see [Runners](#runners)). Returns `{lease: {token, expires_at}}`. `409 leased` while another runner holds a live lease, with `details.expires_at` saying until when. `ttl_seconds` defaults to 300, max 43200. |
| `POST /bots/:id/release` `{lease_token?, force?}`  | Drop the lease, so the next runner needn't wait out the TTL. `409 lease_mismatch` if the token isn't the live lease, `409 not_leased` if there is none. `force: true` drops whoever's lease, no token needed: for a runner that died without releasing. |
| `POST /bots/:id/cursor` `{seq, lease_token}`       | Move the cursor forward to `seq`; it never moves backwards. Returns the bot. `409` if the token isn't the live lease.                                                                          |

`inbox_ids` must be your inboxes. Bot shape: `{id, name, kind, model, inbox_ids, cursor, created_at}`; the lease is never part of it.

Two webhooks landing at once can commit out of `seq` order, and a cursor that had moved past the later one would skip the earlier. So `messages` stops at the first message received in the last few seconds, giving inserts still in flight time to land.


## Threads

A thread is an agent session working on one or more issues and PRs. It belongs to one bot, and its id is the Claude session id (a UUID made by the client). A message is assigned to at most one thread per bot. Transcripts and the Claude session itself stay on one machine, so a thread belongs to the [runner](#runners) that claimed it, until someone releases it. Only that runner, holding its live lease, changes the thread, so a thread can't run twice. The bot's lease covers reading its messages and assigning them to threads.

Thread shape: `{id, bot_id, status, started, interrupted, limited, runner_id, subjects, waiting, inflight, delivered, created_at, updated_at}`. `runner_id` is the owning runner, null until one claims the thread.

- `status` is `active` or `ended`.
- `subjects` are the things the thread works on. For GitHub, its issues and PRs (`owner/repo#number`). Assigning a message means working out the message's subjects and finding the thread that has one of them. A subject belongs to one thread per bot.
- `waiting` and `inflight` are message lists of `{id, inbox_id, type, subject}`, enough to deliver without fetching each message. `waiting` is assigned but not handed to a run; `inflight` was handed to a run that hasn't finished. `delivered` is a count.

| Endpoint | |
| --- | --- |
| `GET /bots/:id/threads` `?status=active\|ended\|all` | List (default `active`), oldest first. |
| `GET /bots/:id/threads/:threadId` | One thread, plus `delivered_ids`. |
| `POST /bots/:id/assign` `{lease_token, cursor, assignments}` | In one transaction: creates the threads the bot doesn't have yet, adds subjects, inserts each message as `waiting` (one already assigned is skipped), and moves the bot's cursor forward to `cursor` (a `seq`). Each assignment is `{message_id, thread_id, add_subjects?, subject?}` (`subject` is for display). Returns `{assigned}`. The messages must be in the bot's inboxes (`400`). `409 thread_exists` if a `thread_id` is another bot's, `409 subject_taken` if a subject is on another thread. |
| `POST /bots/:id/threads/:threadId/claim` `{lease_token}` | Make the runner holding the live lease `lease_token` (a runner lease) the thread's owner. Fine if it already is; returns the thread. `409 thread_owned` if another runner owns it, `409 runner_not_leased` if the token isn't a live runner lease. |
| `POST /bots/:id/threads/:threadId/release` | Give the thread up, so a runner can claim it: the manual move for when its runner is gone. Needs no lease. Returns the thread. |
| `PATCH /bots/:id/threads/:threadId` `{lease_token, status?, started?, interrupted?, limited?, add_subjects?}` | Update. Returns the thread. |
| `POST /bots/:id/threads/:threadId/deliver` `{lease_token}` | Moves `waiting` to `inflight`, sets `status` to `active`, and returns `{data: [message]}`. |
| `POST /bots/:id/threads/:threadId/finish` `{lease_token, requeue?}` | Moves `inflight` to `delivered`, or back to `waiting` with `requeue: true`. Returns `{moved}`. |
| `POST /bots/:id/threads` `{id, subjects, status, started, interrupted?, limited?, runner_id?, refresh?, messages}` | Import a thread with this id; `messages` is `[{id, state, subject?}]` with `state` `waiting`, `inflight` or `delivered`. Needs no lease; `runner_id` makes that runner the owner. `409 thread_exists` if the id exists, `409 subject_taken` if a subject is on another thread. Messages that don't exist are skipped. Returns `201 {thread, skipped}`. With `refresh: true`, a thread that exists and is owned by `runner_id` is brought up to date instead (status, flags, subjects and the listed messages' states; `200`); `409 thread_owned` if another runner, or none, owns it. |

`assign` needs the bot's live `lease_token`. `PATCH`, `deliver` and `finish` take the live lease token of the runner that owns the thread as `lease_token`: `409` (`runner_not_leased`, `thread_unclaimed` or `thread_owned`) otherwise, and nothing changes. A new thread has no owner until a runner claims it. Import needs no lease. An unknown thread, or one of another bot or user, is `404`.
