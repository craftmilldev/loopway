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

The list endpoints `GET /api/inboxes`, `/api/bots`, `/api/runners`, `/api/events`, `/api/inboxes/activity` and `/api/bots/activity` take a required `?org=<slug>` and list only that org's entities, so two orgs' records never share a list. Without it they return `400 org_required`; a slug you aren't a member of, or that doesn't exist, is a `404`. Endpoints that name one entity by id need no org.

Org memberships and pending invites record `created_by` too (the member who added them; yourself for an org you made; an invitee who joins keeps their invite's), but the members endpoints don't return it. Inboxes, bots, runners and threads carry `created_by`, who made them as an actor: `user:<uuid>`, `bot:<uuid>` or `runner:<id>`. A user makes inboxes, bots and runners through the API; a thread is made by the runner whose lease on the bot assigned it (`bot:<uuid>` if the lease named no runner). It is informational only and never decides access (membership of the entity's org does).

## Inboxes

|                                                |                                                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/sources`                                 | Available source types: `type`, `label`, `description`, common `events`, who makes the `secret` (`{from: "loopway", min_length}` or `{from: "sender"}`), and `webhook_settings` (where the webhook is added in the sender). `can_request` says whether this deployment takes source requests. |
| `POST /api/sources/requests` `{description}` | Ask for a source type loopway doesn't have. Posts a `source.requested` message (the description and the asker's user id) to the deployment's requests inbox. `202`; `404` where requests are off. |
| `POST /api/inboxes` `{org, name, source_type, config?}` | Create in the org with slug `org` (required: `400 org_required`; an unknown org or one you aren't a member of: `404`). Response includes `webhook_url` and `setup` instructions, and is the only one that carries the inbox's webhook secret (`config.secret`). It is stored encrypted and never readable again; every other response has `config.secret_set` instead.                                                                                                                                                           |
| `GET /api/inboxes`                                 | List yours.                                                                                                                                                                                                                 |
| `GET /api/inboxes/:id`                             | One inbox + `stats` (`{messages}`: how many it holds).                                                                                                                                                                        |
| `PATCH /api/inboxes/:id` `{name?, config?}`        | Update. Config merges onto existing (secret kept unless given; a new one is not echoed back).                                                                                                                                                             |
| `DELETE /api/inboxes/:id`                          | Deletes the inbox and its messages.                                                                                                                                                                                           |

Each source's `config`, how to connect it in the sender, and how its deliveries map to CloudEvents are in `docs/sources/`: [github](sources/github.md), [vercel](sources/vercel.md), [linear](sources/linear.md), [granola](sources/granola.md), [resend](sources/resend.md), [loopway](sources/loopway.md) and [schedule](sources/schedule.md).

## Webhook ingestion

`POST /api/webhooks/:inboxId` — no API key; authenticated by the source: a signature header, or a bearer token for `loopway` inboxes (see each source's doc).

- `202 {id, duplicate:false}` stored
- `200 {id, duplicate:true}` redelivery of a message already stored (same CloudEvent `source`+`id`)
- `200 {ignored:true, reason}` `ping`
- `400` malformed body (for Loopway, one that doesn't match the inbox schema) · `401` bad/missing signature or token (or, for Vercel, Granola and Resend, no secret set yet) · `404` unknown inbox · `415` unsupported content type · `422` event type not in `config.events` (GitHub shows it as a failed delivery and doesn't retry it; Vercel retries any non-2xx for up to 24 hours; Granola retries only 408, 429 and 5xx)

## Sending a test message

`POST /api/inboxes/:id/test` `{from?}` — session auth; you must be a member of the inbox's org (`404` otherwise). It builds a small sample event for the inbox's source, signs it with the inbox's stored secret the way the sender would, and runs it through the same handler as `POST /api/webhooks/:inboxId`, so it is stored and delivered like any message. `201 {message_id, seq}`. Each call stores a new message.

- The message is stored with `is_test` set, and `GET /api/inboxes/:id/messages` returns it as `test: true` (`false` for every other message); the inbox page shows a `test` badge. The CloudEvent itself is the sample, unmarked. Only this route sets it: no webhook can.
- If the inbox's `events` filter rejects the sample's type, the first sample type the inbox accepts is sent instead. If it accepts none: `422 no_accepted_type`.
- For a source whose sender makes the secret (Linear, Vercel, Granola, Resend) that hasn't been pasted in yet: `409 secret_not_set`.
- A sample the inbox refuses anyway (a `loopway` inbox whose schema the sample doesn't match) answers what the webhook would: `400` or `422`.
- `from` (`inbox_page`, `zero_state` or `cli`, default `cli`) only labels the `test_message_sent` / `test_message_failed` metric events.

From the CLI: `loopway inbox test <inbox>`.

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

A runner is a machine running loopway, and belongs to one org for good: it only runs the bots of that org, and only claims their threads (`400 runner_org_mismatch` otherwise, even for a user who is in both orgs). The CLI makes its id (one per org, kept in `~/.loopway/runner.json`) and registers it on startup. A process leases its runner while it runs, so only one process uses a runner id at a time. A thread belongs to the runner that claimed it (see [Threads](#threads)).

| Endpoint | |
| --- | --- |
| `POST /api/runners` `{org, id, name}` | Register the runner in the org (a slug), or rename it and mark it seen; safe to repeat. `400 org_required` without `org`, `404` if you aren't in the org, `409 runner_org_mismatch` (with `details.org`, the runner's org) if the id is already a runner of another org of yours, `409 runner_exists` if the id is already in use by a runner you can't use. |
| `POST /api/runners/:id/lease` `{ttl_seconds?, lease_token?}` | Take the runner's lease, or renew it by passing your current token. Returns `{lease: {token, expires_at}}`. `409 runner_leased` while another process holds a live lease, with `details.expires_at`. `ttl_seconds` defaults to 300, max 43200. |
| `POST /api/runners/:id/release` `{lease_token?, force?}` | Drop the lease. `409 runner_lease_mismatch` if the token isn't the live lease. `force: true` drops whoever's, for a process that died without releasing. |
| `GET /api/runners/:id/work` `?bots=<id>,<id>` + header `x-lease-token: <runner lease>` | What the runner has to do for those bots (up to 100; ones outside the runner's org, or deleted, are ignored), in one request: `{data: [thread]}`, each a [thread](#threads) with its `waiting` and `inflight` messages, so a tick needs no per-bot call. It holds the runner's own threads with a message `waiting`, or `limited` or `interrupted` (a run to resume), and the unowned threads with a message `waiting`, which any runner of the org can claim with `POST /api/bots/:id/threads/:threadId/claim` (the runner lease, not a bot lease). Oldest first. Catches up the routing of the listed bots first. `409 runner_not_leased` unless the header is this runner's live lease, `400` for bad bot ids. Missing (`404`) when the server doesn't route messages itself (`SERVER_ROUTING=off`) or is older than the feed; the CLI needs it. |
| `GET /api/runners` | Your runners: `{id, org_id, created_by, org, name, created_at, last_seen_at, leased_until, threads}` (`org` is the org's slug). `leased_until` is null unless a process holds the lease, and `threads` counts the threads it owns. The lease token is never part of it. |

## Bots

A bot reads the messages of one or more of your inboxes, in `seq` order, and keeps a `cursor`: the `seq` of the last message it has read past. The server moves the cursor itself as it routes the bot's messages to threads; nothing else does.

|                                                    |                                                                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/bots` `{org, name, harness, model?, inbox_ids, prompt?, rules?}` | Create in the org with slug `org` (required: `400 org_required`; an unknown org or one you aren't a member of: `404`). `inbox_ids` must be inboxes of that org (`400 inbox_org_mismatch`). `harness` is one of `claude`, `codex`, `cursor`, `hermes` and `script`. `model` must be one the harness takes, else `400 invalid_model`; a `script` bot may leave it out (it gets the placeholder `see-script`), every other harness needs one. Every session the bot runs uses the harness and model. A `prompt` (with optional `rules`) becomes its first version; the CLI and dashboard fill them from a preset. The `cursor` starts at the newest message in its inboxes, so a new bot doesn't replay history.         |
| `GET /api/bots`                                        | List yours.                                                                                                                                                                                     |
| `GET /api/bots/activity` `?days=`                      | What each of your bots delivered over the last `days` UTC days, today included (1 to 30, default 14; anything else is `400`): `{data: [{bot_id, days: [{date, delivered}], delivered, last_delivery_at, runs, median_wait_seconds}]}`. `days` is oldest first with a zero for a day with no deliveries. A delivery is a thread message with `delivered_at` set, counted on that day; a run is the messages of one thread delivered at the same instant; `median_wait_seconds` is the median of `delivered_at - assigned_at` over the window's deliveries (null with none). `last_delivery_at` is the newest delivery ever, null if none. |
| `GET /api/bots/:id/activity` `?days=`                  | The same for one bot, as a single object. `404` for a bot that isn't yours.                                                                                                                      |
| `GET /api/bots/:id`                                    | One bot.                                                                                                                                                                                        |
| `PATCH /api/bots/:id` `{name?, model?, harness?, inbox_ids?}`            | Update. `inbox_ids` replaces the bot's inboxes; the cursor stays where it is. `409 harness_not_swappable` for a switch to or from `script`, `409 harness_in_use` while started threads are still active in the old harness, `400 invalid_model` if the new harness and model don't fit together.                                                                                                                   |
| `DELETE /api/bots/:id`                                 | Delete. The row is kept with `deleted_at` set, but the API no longer returns it. Deleting an inbox also removes it from its bots.                                                                                |
| `GET /api/bots/:id/messages` `?limit=`                 | Messages in the bot's inboxes with `seq > cursor`, oldest first (`limit` ≤100, default 50). Messages received in the last 5 seconds, and anything after them, are held back (see below). The server also routes the bot's messages first (see below), so a runner that doesn't route sees none.       |

Inboxes, bots and runners name their org, so before the user has chosen a username (that makes their personal org) they answer `404`. A bot's `inbox_ids` must be your inboxes, all in the bot's org: `400 inbox_org_mismatch` otherwise. Bot shape: `{id, org_id, created_by, name, model, harness, inbox_ids, prompt_version, cursor, created_at}`.

Two webhooks landing at once can commit out of `seq` order, and a cursor that had moved past the later one would skip the earlier. So `messages` stops at the first message received in the last few seconds, giving inserts still in flight time to land.

The server routes a bot's messages to threads itself, with the rules of the bot's newest version and no lease. Right after a message is stored (a webhook, a test message, a schedule tick, a message sent to a thread) the same invocation routes it, once the response is out; a message that routing missed is routed by the next `GET /api/bots/:id/messages`, `GET /api/bots/:id/threads` or `POST /api/bots/:id/lease`. It assigns as `POST /api/bots/:id/assign` does and moves the cursor, so a message that no rule attaches is dropped, as it is for a runner. A message whose rules throw is skipped and logged, and later messages still route. New threads have no `runner_id` until a runner claims them, unless a rule's `runner` names a runner of the org, which then owns the thread from the start (a name the org doesn't have means any runner). A bot with no rules is not routed. Set `SERVER_ROUTING=off` on the deploy to turn this off.


## Threads

A thread is one agent session. A bot thread belongs to one bot and works on one or more subjects (for GitHub, an issue and its PRs); a manager thread belongs to the org (see [Manager threads](#manager-threads)). Its id is the session's id, a UUID made by the client. A message is assigned to at most one thread per bot. Transcripts and the agent session itself stay on one machine, so a thread belongs to the [runner](#runners) that claimed it, until someone releases it. Only that runner, holding its live lease, changes the thread, so a thread can't run twice. The bot's lease covers reading its messages and assigning them to threads.

Thread shape: `{id, bot_id, kind, created_by, status, started, interrupted, limited, runner_id, automation_level, subjects, metadata, waiting, inflight, delivered, created_at, updated_at}`. `runner_id` is the owning runner, null until one claims the thread. `automation_level` is 2 if a person started the thread, 3 if a bot did and a person took part, 4 if no person did. It comes from the `author_kind` (`human` or `bot`) that the bot's rules give each assignment: the thread's first message sets it, and a person's later message moves 4 to 3. It's null for a thread whose first message has no `author_kind`.

- `status` is `active` or `ended`.
- `subjects` are the things the thread works on. For GitHub, its issues and PRs (`owner/repo#number`). Assigning a message means working out the message's subjects and finding the thread that has one of them. A subject belongs to one thread per bot.
- `waiting` and `inflight` are message lists of `{id, inbox_id, type, subject}`, enough to deliver without fetching each message. `waiting` is assigned but not handed to a run; `inflight` was handed to a run that hasn't finished. `delivered` is a count.

| Endpoint | |
| --- | --- |
| `GET /api/bots/:id/threads` `?status=active\|ended\|all` | List (default `active`), oldest first. |
| `GET /api/bots/:id/threads/:threadId` | One thread, plus `delivered_ids`. |
| `POST /api/bots/:id/threads/:threadId/claim` `{lease_token}` | Make the runner holding the live lease `lease_token` (a runner lease) the thread's owner. Fine if it already is; returns the thread. `409 thread_owned` if another runner owns it (first claim wins: of two runners racing for an unowned thread, one gets the thread and the other this), `409 runner_not_leased` if the token isn't a live runner lease. |
| `POST /api/bots/:id/threads/:threadId/release` | Give the thread up, so a runner can claim it: the manual move for when its runner is gone. Needs no lease. Returns the thread. |
| `POST /api/bots/:id/threads/:threadId/messages` | Send the thread a message: `{"text": "…"}` (1–20,000 characters). It is stored in the bot's first inbox as a `dev.loopway.thread.message` whose subject and `data.thread_id` are the thread's id, and the bot's runner routes it to that thread as a person's message, whatever the bot's rules say. Needs no lease. Returns `{id, inbox_id}` (201). `409 no_inbox` if the bot has no inbox. |
| `POST /api/bots/:id/threads/:threadId/end` | End the thread, for when its work is done or its runner is gone. Needs no lease; fine on an ended thread. Its `waiting` and `inflight` messages stay as they are, as when a runner ends it with `PATCH`. Returns the thread. |
| `PATCH /api/bots/:id/threads/:threadId` `{lease_token, status?, started?, interrupted?, limited?, add_subjects?, metadata_set?, metadata_unset?}` | Update. Returns the thread. `metadata_set` is an object of keys to JSON values, merged into the thread's `metadata`; `metadata_unset` is an array of keys to remove (applied after the set). Every thread read returns `metadata` (`{}` until a session records something). `400 metadata_too_large` if the result would be over 16 KB serialized; the update is not applied. |
| `POST /api/bots/:id/threads/:threadId/move-subject` `{subject, to_thread_id}` | Move `subject` from this thread to `to_thread_id`, another of the bot's threads, in one statement. The subject's `waiting` messages go with it; `inflight` and `delivered` ones stay. An `ended` target becomes `active`. Needs no lease. Returns the target thread. `404` if the subject isn't on this thread or either thread isn't the bot's, `400` if both are the same thread. |
| `POST /api/bots/:id/threads/:threadId/deliver` `{lease_token}` | Moves `waiting` to `inflight`, sets `status` to `active`, and returns `{data: [message]}`. |
| `POST /api/bots/:id/threads/:threadId/finish` `{lease_token, requeue?}` | Moves `inflight` to `delivered`, or back to `waiting` with `requeue: true`. Returns `{moved}`. |
| `POST /api/bots/:id/threads` `{id, subjects, status, started, interrupted?, limited?, runner_id?, refresh?, messages}` | Import a thread with this id; `messages` is `[{id, state, subject?}]` with `state` `waiting`, `inflight` or `delivered`. Needs no lease; `runner_id` makes that runner the owner. `409 thread_exists` if the id exists, `409 subject_taken` if a subject is on another thread. Messages that don't exist are skipped. Returns `201 {thread, skipped}`. With `refresh: true`, a thread that exists and is owned by `runner_id` is brought up to date instead (status, flags, subjects and the listed messages' states; `200`); `409 thread_owned` if another runner, or none, owns it. |

### Manager threads

A manager thread is a chat with an org's manager bot. It belongs to the org and one [runner](#runners), not to a bot: `bot_id` is null and `kind` is `manager` (`bot` for every other thread, which the bot endpoints above serve). Manager threads never appear under `/api/bots/:id/threads`, and the bot endpoints answer `404` for one. They have no subjects or messages, so `subjects`, `waiting` and `inflight` are always empty. Its id is the chat's session id (a UUID made by the client). Only the runner that made it, holding its live lease, changes it, as for any thread. Members of the org read them.

| Endpoint | |
| --- | --- |
| `GET /api/orgs/:slug/threads` `?kind=manager\|bot` | The org's threads of that kind (default `manager`), oldest first, as `{data}`. |
| `GET /api/orgs/:slug/threads/:threadId` | One manager thread. |
| `POST /api/orgs/:slug/threads` `{id, lease_token}` | Make a manager thread with this id, owned by the runner holding the live lease `lease_token`, and `active`. Returns it (`201`). `409 thread_exists` if the id is taken, `409 runner_not_leased` if the token isn't a live runner lease, `400 runner_org_mismatch` if that runner belongs to another org. |
| `PATCH /api/orgs/:slug/threads/:threadId` `{lease_token, status?, metadata_set?, metadata_unset?}` | Update, with the same `metadata_set` / `metadata_unset` semantics and `400 metadata_too_large` limit as the bot thread `PATCH`. Returns the thread. `409 thread_owned` if another runner owns it, `409 runner_not_leased` if the token isn't a live lease. |

The runner labels each chat in `metadata`: `label` is `generic` if the chat made no approved create, update or delete, otherwise the most frequent of `create`, `update` and `delete` (a tie goes to the one done first), and `actions` counts the kinds that ran, such as `{"create": 2, "delete": 1}`.

`PATCH`, `deliver` and `finish` take the live lease token of the runner that owns the thread as `lease_token`: `409` (`runner_not_leased`, `thread_unclaimed` or `thread_owned`) otherwise, and nothing changes. A new thread has no owner until a runner claims it. Import needs no lease. An unknown thread, or one of another bot or user, is `404`.
