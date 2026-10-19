# API

The `loopway` server is a plain HTTP API; the [CLI](../README.md#cli) is a client of it. This file is the contract.


Every route below is served under `/api` (the paths here include it); the web pages and static assets live outside it, and the old top-level paths (`/inboxes`, `/auth/login`, ...) answer `404`.

Users are created with `loopway login` (or the web UI). Every endpoint except `/api/webhooks/*`, `/api/health`, `/api` and the web pages takes `Authorization: Bearer <token>`. The token is a session JWT from `loopway login`, valid 30 days.
Errors look like `{ "error": { "code": "...", "message": "..." } }`.

## Users

|                                     |                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login` `{email}`        | Email an 8-character code (valid 10 min) via Resend. Always `202`. At most one email per address per 10 minutes; asking again sooner sends nothing.                                    |
| `POST /api/auth/verify` `{email, code, username?}` | Trade the code for a session token (`201 {token, expires_at, user, created}`). Single use, 5 guesses. If the email has no user yet, `username` is required and creates the user (named after the username), their personal org and its membership together. Without it: `400 username_required`; a bad one: `400 invalid_username` / `username_reserved`, `409 username_taken`. These leave the code valid (and spend no guess) so the call can be repeated. Existing users ignore `username`. |
| `GET /api/me` | Current user, with `username` (null only for accounts made before signup required one). |
| `PATCH /api/me/username` `{username}` | Set the username, which makes the user's personal org (slug = username); afterwards, rename it. Lowercase `[a-z0-9-]`, 2-39 chars, no leading/trailing `-`, not reserved. `400 invalid_username` / `username_reserved`, `409 username_taken`. |
| `GET /api/usernames/:username` | `{username, available, reason?, message?}`: whether the name can be used (your own current one counts as available). |
| `GET /api/orgs` | Orgs you belong to: `{data: [{id, slug, name, personal}]}`. |
| `POST /api/orgs` `{slug, name?}` | Creates a shared (non-personal) org with you as its only member; `name` defaults to the slug. `201` with `{id, slug, name, personal}`. The slug follows the username rules (it is trimmed and lowercased) and shares their namespace, with the same errors: `400 invalid_username`, `400 username_reserved`, `409 username_taken` (including someone's username). |
| `GET /api/orgs/:slug/available` | `{slug, available, reason?, message?}`: whether the slug can be used for a new org. Unlike `/api/usernames/:username`, your own username counts as taken. |
| `GET /api/orgs/:slug/members` | `{members: [{id, username, email}], pending: [email]}`. `pending` are emails added before they had an account. `404` if you aren't a member of the org. |
| `POST /api/orgs/:slug/members` `{email}` | Any member can add someone. The email is trimmed and lowercased. If a user has it they become a member at once; otherwise it is stored as pending and becomes a membership when someone first logs in with it, within 7 days (after that it lapses and is no longer listed; adding the email again starts a new one) (no email is sent, no accept step). `201` with the list as in `GET`, or `200` with it unchanged if they were already a member or pending. `400` for a bad email, `404` for a non-member, `409 personal_org` for a personal org, which never has anyone but its owner (nothing is stored, no pending email either). |
| `DELETE /api/orgs/:slug/members/:userId` | Remove a member, yourself included (leaving). `204`. `404` if you aren't a member of the org or `userId` isn't one; `409 last_member` for the org's only member, and `409 personal_owner` for the owner of a personal org (others who joined it can leave), so its owner can never leave it. |
| `DELETE /api/orgs/:slug/members/pending?email=` | Withdraw a pending email. `204`; `404` if it isn't pending or you aren't a member. |

The list endpoints `GET /api/inboxes`, `/api/bots`, `/api/runners`, `/api/events`, `/api/inboxes/activity` and `/api/bots/activity` take an optional `?org=<slug>` and then list only that org's entities. A slug you aren't a member of, or that doesn't exist, is a `404`. Without it they list all your orgs'.

Org memberships and pending invites record `created_by` too (the member who added them; yourself for an org you made; an invitee who joins keeps their invite's), but the members endpoints don't return it. Inboxes, bots, runners and threads carry `created_by`, who made them as an actor: `user:<uuid>`, `bot:<uuid>` or `runner:<id>`. A user makes inboxes, bots and runners through the API; a thread is made by the runner whose lease on the bot assigned it (`bot:<uuid>` if the lease named no runner). It is informational only and never decides access (membership of the entity's org does).

## Inboxes

|                                                |                                                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/sources`                                 | Available source types: `type`, `label`, `description`, common `events`, who makes the `secret` (`{from: "loopway", min_length}` or `{from: "sender"}`), and `webhook_settings` (where the webhook is added in the sender). `can_request` says whether this deployment takes source requests. |
| `POST /api/sources/requests` `{description}` | Ask for a source type loopway doesn't have. Posts a `source.requested` message (the description and the asker's user id) to the deployment's requests inbox. `202`; `404` where requests are off. |
| `POST /api/inboxes` `{org, name, source_type, config?}` | Create in the org with slug `org` (required: `400 org_required`; an unknown org or one you aren't a member of: `404`). Response includes `webhook_url` and `setup` instructions.                                                                                                                                                           |
| `GET /api/inboxes`                                 | List yours.                                                                                                                                                                                                                 |
| `GET /api/inboxes/:id`                             | One inbox + `stats` (`{messages}`: how many it holds).                                                                                                                                                                        |
| `PATCH /api/inboxes/:id` `{name?, config?}`        | Update. Config merges onto existing (secret kept unless given).                                                                                                                                                             |
| `DELETE /api/inboxes/:id`                          | Deletes the inbox and its messages.                                                                                                                                                                                           |

Each source's `config`, how to connect it in the sender, and how its deliveries map to CloudEvents are in `docs/sources/`: [github](sources/github.md), [vercel](sources/vercel.md), [linear](sources/linear.md), [granola](sources/granola.md), [resend](sources/resend.md), [loopway](sources/loopway.md) and [schedule](sources/schedule.md).

## Webhook ingestion

`POST /api/webhooks/:inboxId` — no API key; authenticated by the source: a signature header, or a bearer token for `loopway` inboxes (see each source's doc).

- `202 {id, duplicate:false}` stored
- `200 {id, duplicate:true}` redelivery of a message already stored (same CloudEvent `source`+`id`)
- `200 {ignored:true, reason}` `ping`
- `400` malformed body (for Loopway, one that doesn't match the inbox schema) · `401` bad/missing signature or token (or, for Vercel, Granola and Resend, no secret set yet) · `404` unknown inbox · `415` unsupported content type · `422` event type not in `config.events` (GitHub shows it as a failed delivery and doesn't retry it; Vercel retries any non-2xx for up to 24 hours; Granola retries only 408, 429 and 5xx)


## Messages

All under `/api/inboxes/:inboxId/messages`. A message is a stored delivery: there's no per-message status, and nothing marks one done. Bots keep their place with a cursor (see [Bots](#bots)).

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

A runner is a machine running loopway, and belongs to one org for good: it only leases and runs the bots of that org, and only claims their threads (`400 runner_org_mismatch` otherwise, even for a user who is in both orgs). The CLI makes its id (kept in `~/.loopway/runner.json`) and registers it on startup. A process leases its runner while it runs, so only one process uses a runner id at a time. A bot lease records which runner holds it, and a thread belongs to the runner that claimed it (see [Threads](#threads)).

| Endpoint | |
| --- | --- |
| `POST /api/runners` `{org, id, name}` | Register the runner in the org (a slug), or rename it and mark it seen; safe to repeat. `400 org_required` without `org`, `404` if you aren't in the org, `409 runner_org_mismatch` (with `details.org`, the runner's org) if the id is already a runner of another org of yours, `409 runner_exists` if the id is already in use by a runner you can't use. |
| `POST /api/runners/:id/lease` `{ttl_seconds?, lease_token?}` | Take the runner's lease, or renew it by passing your current token. Returns `{lease: {token, expires_at}}`. `409 runner_leased` while another process holds a live lease, with `details.expires_at`. `ttl_seconds` defaults to 300, max 43200. |
| `POST /api/runners/:id/release` `{lease_token?, force?}` | Drop the lease. `409 runner_lease_mismatch` if the token isn't the live lease. `force: true` drops whoever's, for a process that died without releasing. |
| `GET /api/runners` | Your runners: `{id, org_id, created_by, org, name, created_at, last_seen_at, leased_until, bots, threads}` (`org` is the org's slug). `leased_until` is null unless a process holds the lease, `bots` is `[{id, name}]` for the bot leases it holds now, and `threads` counts the threads it owns. The lease token is never part of it. |

## Bots

A bot reads the messages of one or more of your inboxes, in `seq` order, and keeps a `cursor`: the `seq` of the last message it has read past. A runner (`loopway bots run`) takes a lease on the bot while it reads, so only one runner at a time moves the cursor.

|                                                    |                                                                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/bots` `{org, name, model, inbox_ids, prompt?, rules?}` | Create in the org with slug `org` (required: `400 org_required`; an unknown org or one you aren't a member of: `404`). `inbox_ids` must be inboxes of that org (`400 inbox_org_mismatch`). `model` is one of the aliases or ids in `packages/web/src/models.ts` (`sonnet`, `opus`, `claude-sonnet-5-5`, ...), else `400`; every session the bot runs uses it. A `prompt` (with optional `rules`) becomes its first version; the CLI and dashboard fill them from a preset. The `cursor` starts at the newest message in its inboxes, so a new bot doesn't replay history.         |
| `GET /api/bots`                                        | List yours.                                                                                                                                                                                     |
| `GET /api/bots/activity` `?days=`                      | What each of your bots delivered over the last `days` UTC days, today included (1 to 30, default 14; anything else is `400`): `{data: [{bot_id, days: [{date, delivered}], delivered, last_delivery_at, runs, median_wait_seconds}]}`. `days` is oldest first with a zero for a day with no deliveries. A delivery is a thread message with `delivered_at` set, counted on that day; a run is the messages of one thread delivered at the same instant; `median_wait_seconds` is the median of `delivered_at - assigned_at` over the window's deliveries (null with none). `last_delivery_at` is the newest delivery ever, null if none. |
| `GET /api/bots/:id/activity` `?days=`                  | The same for one bot, as a single object. `404` for a bot that isn't yours.                                                                                                                      |
| `GET /api/bots/:id`                                    | One bot.                                                                                                                                                                                        |
| `PATCH /api/bots/:id` `{name?, model?, inbox_ids?}`            | Update. `inbox_ids` replaces the bot's inboxes; the cursor stays where it is.                                                                                                                   |
| `DELETE /api/bots/:id`                                 | Delete. The row is kept with `deleted_at` set, but the API no longer returns it. Deleting an inbox also removes it from its bots.                                                                                |
| `GET /api/bots/:id/messages` `?limit=`                 | Messages in the bot's inboxes with `seq > cursor`, oldest first (`limit` ≤100, default 50). Messages received in the last 5 seconds, and anything after them, are held back (see below).       |
| `POST /api/bots/:id/lease` `{ttl_seconds?, lease_token?, runner_id?}` | Take the bot's lease, or renew it by passing your current token. `runner_id` records the holder (see [Runners](#runners)). Returns `{lease: {token, expires_at}}`. `409 leased` while another runner holds a live lease, with `details.expires_at` saying until when. `ttl_seconds` defaults to 300, max 43200. |
| `POST /api/bots/:id/release` `{lease_token?, force?}`  | Drop the lease, so the next runner needn't wait out the TTL. `409 lease_mismatch` if the token isn't the live lease, `409 not_leased` if there is none. `force: true` drops whoever's lease, no token needed: for a runner that died without releasing. |
| `POST /api/bots/:id/cursor` `{seq, lease_token}`       | Move the cursor forward to `seq`; it never moves backwards. Returns the bot. `409` if the token isn't the live lease.                                                                          |

Inboxes, bots and runners name their org, so before the user has chosen a username (that makes their personal org) they answer `404`. A bot's `inbox_ids` must be your inboxes, all in the bot's org: `400 inbox_org_mismatch` otherwise. Bot shape: `{id, org_id, created_by, name, model, inbox_ids, cursor, created_at}`; the lease is never part of it.

Two webhooks landing at once can commit out of `seq` order, and a cursor that had moved past the later one would skip the earlier. So `messages` stops at the first message received in the last few seconds, giving inserts still in flight time to land.


## Threads

A thread is an agent session working on one or more issues and PRs. It belongs to one bot, and its id is the Claude session id (a UUID made by the client). A message is assigned to at most one thread per bot. Transcripts and the Claude session itself stay on one machine, so a thread belongs to the [runner](#runners) that claimed it, until someone releases it. Only that runner, holding its live lease, changes the thread, so a thread can't run twice. The bot's lease covers reading its messages and assigning them to threads.

Thread shape: `{id, bot_id, created_by, status, started, interrupted, limited, runner_id, automation_level, subjects, waiting, inflight, delivered, created_at, updated_at}`. `runner_id` is the owning runner, null until one claims the thread. `automation_level` is 2 if a person started the thread, 3 if a bot did and a person took part, 4 if no person did. It comes from the `author_kind` (`human` or `bot`) that the bot's rules give each assignment: the thread's first message sets it, and a person's later message moves 4 to 3. It's null for a thread whose first message has no `author_kind`.

- `status` is `active` or `ended`.
- `subjects` are the things the thread works on. For GitHub, its issues and PRs (`owner/repo#number`). Assigning a message means working out the message's subjects and finding the thread that has one of them. A subject belongs to one thread per bot.
- `waiting` and `inflight` are message lists of `{id, inbox_id, type, subject}`, enough to deliver without fetching each message. `waiting` is assigned but not handed to a run; `inflight` was handed to a run that hasn't finished. `delivered` is a count.

| Endpoint | |
| --- | --- |
| `GET /api/bots/:id/threads` `?status=active\|ended\|all` | List (default `active`), oldest first. |
| `GET /api/bots/:id/threads/:threadId` | One thread, plus `delivered_ids`. |
| `POST /api/bots/:id/assign` `{lease_token, cursor, assignments}` | In one transaction: creates the threads the bot doesn't have yet, adds subjects, inserts each message as `waiting` (one already assigned is skipped), and moves the bot's cursor forward to `cursor` (a `seq`). Each assignment is `{message_id, thread_id, add_subjects?, subject?, author_kind?}` (`subject` is for display; `author_kind` is `human` or `bot` and sets the thread's `automation_level`). Returns `{assigned}`. The messages must be in the bot's inboxes (`400`). `409 thread_exists` if a `thread_id` is another bot's, `409 subject_taken` if a subject is on another thread. |
| `POST /api/bots/:id/threads/:threadId/claim` `{lease_token}` | Make the runner holding the live lease `lease_token` (a runner lease) the thread's owner. Fine if it already is; returns the thread. `409 thread_owned` if another runner owns it, `409 runner_not_leased` if the token isn't a live runner lease. |
| `POST /api/bots/:id/threads/:threadId/release` | Give the thread up, so a runner can claim it: the manual move for when its runner is gone. Needs no lease. Returns the thread. |
| `POST /api/bots/:id/threads/:threadId/messages` | Send the thread a message: `{"text": "…"}` (1–20,000 characters). It is stored in the bot's first inbox as a `dev.loopway.thread.message` whose subject and `data.thread_id` are the thread's id, and the bot's runner routes it to that thread as a person's message, whatever the bot's rules say. Needs no lease. Returns `{id, inbox_id}` (201). `409 no_inbox` if the bot has no inbox. |
| `POST /api/bots/:id/threads/:threadId/replies` | A session's `reply` tool: `{"lease_token": "…", "text": "…"}`, written by the thread's runner. Stored in the bot's first inbox as a `dev.loopway.reply` whose subject and `data.thread_id` are the thread's id; it is for whoever messaged the thread through loopway (the setup bot's caller), not a message to the user on another channel. Returns `{id, inbox_id}` (201). |
| `POST /api/bots/:id/threads/:threadId/end` | End the thread, for when its work is done or its runner is gone. Needs no lease; fine on an ended thread. Its `waiting` and `inflight` messages stay as they are, as when a runner ends it with `PATCH`. Returns the thread. |
| `PATCH /api/bots/:id/threads/:threadId` `{lease_token, status?, started?, interrupted?, limited?, add_subjects?}` | Update. Returns the thread. |
| `POST /api/bots/:id/threads/:threadId/move-subject` `{subject, to_thread_id}` | Move `subject` from this thread to `to_thread_id`, another of the bot's threads, in one statement. The subject's `waiting` messages go with it; `inflight` and `delivered` ones stay. An `ended` target becomes `active`. Needs no lease. Returns the target thread. `404` if the subject isn't on this thread or either thread isn't the bot's, `400` if both are the same thread. |
| `POST /api/bots/:id/threads/:threadId/deliver` `{lease_token}` | Moves `waiting` to `inflight`, sets `status` to `active`, and returns `{data: [message]}`. |
| `POST /api/bots/:id/threads/:threadId/finish` `{lease_token, requeue?}` | Moves `inflight` to `delivered`, or back to `waiting` with `requeue: true`. Returns `{moved}`. |
| `POST /api/bots/:id/threads` `{id, subjects, status, started, interrupted?, limited?, runner_id?, refresh?, messages}` | Import a thread with this id; `messages` is `[{id, state, subject?}]` with `state` `waiting`, `inflight` or `delivered`. Needs no lease; `runner_id` makes that runner the owner. `409 thread_exists` if the id exists, `409 subject_taken` if a subject is on another thread. Messages that don't exist are skipped. Returns `201 {thread, skipped}`. With `refresh: true`, a thread that exists and is owned by `runner_id` is brought up to date instead (status, flags, subjects and the listed messages' states; `200`); `409 thread_owned` if another runner, or none, owns it. |

`assign` needs the bot's live `lease_token`. `PATCH`, `deliver` and `finish` take the live lease token of the runner that owns the thread as `lease_token`: `409` (`runner_not_leased`, `thread_unclaimed` or `thread_owned`) otherwise, and nothing changes. A new thread has no owner until a runner claims it. Import needs no lease. An unknown thread, or one of another bot or user, is `404`.

## Setup bot

Each org can have one hidden setup bot: loopway makes it (and the inbox it reads), runs it on a runner of the org, and owns its prompt. It is left out of `GET /api/bots`, the bot and inbox activity lists and `GET /api/inboxes`; runners get it with `GET /api/bots?hidden=include`. `POST /api/bots/:id/versions`, `PATCH` and `DELETE` on it are `403 bot_hidden`.

| Route | What it does |
| --- | --- |
| `PUT /api/setup-bot` `{org, harness}` | Makes the org's setup bot on the harness (`claude`, `cursor`, `codex` or `hermes`), or moves the existing one to it (`409 harness_in_use` while a started thread is active), and puts loopway's prompt in as its newest version. Returns `{bot_id, inbox_id, harness}` (201 when made, else 200). |
| `POST /api/setup-bot/messages` `{org, text}` | Sends the bot a message (`dev.loopway.setup.message`, always the same thread). `409 no_setup_bot` before `PUT /api/setup-bot`. The bot answers with its `reply` tool; read the answer from the inbox: `GET /api/inboxes/:inbox_id/messages?type=dev.loopway.reply&cursor=<id of the sent message>`. |

`loopway setup ask <message> --harness <h>` does both and prints the reply (it needs `loopway bots run` going for the org).
