# loopway

Accepts webhooks from defined sources, stores them as [CloudEvents](https://github.com/cloudevents/spec) in a per-user **inbox**, and exposes an API to list, lock, claim, and mark events processed.

- **Stack:** TypeScript + [Hono](https://hono.dev), zero-config on Vercel.
- **DB:** Postgres everywhere. Locally [PGlite](https://pglite.dev) (embedded, no server); on Vercel, [Neon](https://neon.tech) via `DATABASE_URL`. Same SQL on both.
- **Data types:** `User` → owns `Inbox`es → which receive `Event`s.
- **Sources:** `github`, `granola`, `loopway`, `vercel` (more can be added in `packages/web/src/sources/`).
- **Packages:** npm workspaces — [`packages/web`](packages/web) (the server) and [`packages/cli`](packages/cli) (the `loopway` command, a client of the API).

## Run locally

```bash
npm install                   # installs every workspace
cp packages/web/.env.example packages/web/.env
npm run dev                   # http://localhost:3000, data in packages/web/.data/pglite
npm test                      # every workspace, in-memory PGlite
npm run lint                  # ESLint, with type-aware rules
npm run format                # Prettier; CI runs format:check
```

Root scripts forward to the workspaces (`lint` and `format` run once over the whole repo); `npm run <script> -w @loopway/web` (or `@loopway/cli`) runs one directly.

Create a user with `loopway login` (the CLI creates the user if the email is new).

To receive real GitHub webhooks locally, expose the port (e.g. `cloudflared tunnel --url localhost:3000`) and set `PUBLIC_BASE_URL` to the tunnel URL.

## Deploy (Vercel + Neon)

1. In Neon → Connect, copy both connection strings: the **direct** one and the **pooled** one (host contains `-pooler`).
2. Run migrations once from your machine against the direct URL: `DATABASE_URL='postgresql://...' npm run db:migrate`
3. In Vercel, import the repo, set **Root Directory** to `packages/web`, and set env vars: `DATABASE_URL_POOLED` (the pooled URL), `DATABASE_URL` (the direct URL), `TOKEN_SECRET` (signs session tokens; `openssl rand -hex 32`), and optionally `PUBLIC_BASE_URL`. The server uses `DATABASE_URL_POOLED` when it's set.
4. Deploy. Vercel picks up `packages/web/src/index.ts` as a Hono app automatically, and runs `npm run build` to bundle the web UI into `packages/web/public/`. The app serves `app.js` and `app.css` itself, since Vercel's CDN only serves the files in `public/` that are committed.
5. Create users with `loopway login` pointed at your deployment.

Tables live in a `loopway` schema (not `public`) with RLS enabled and no policies, so a Data API (Neon's is opt-in) can't reach them.

## Web UI

The same Hono app serves a small web UI: `/` (how to use loopway), `/login` (same email-code flow as the CLI; the session token is kept in `localStorage`), `/dashboard` (your inboxes and a create form) and `/dashboard/<inbox>` (events, newest first, expandable JSON, hide-processed toggle, and, for sources whose sender makes the secret, like Vercel and Granola, a form to paste it). `GET /api` is a bare health check.

The pages are a React app in `packages/web/client/`. The homepage copy is markdown in [`packages/web/content/home.md`](packages/web/content/home.md). `npm run build -w @loopway/web` bundles the app with esbuild into `packages/web/public/` (git-ignored); `npm run dev` rebuilds it on change and serves it.

## CLI

`loopway` lives in `packages/cli` and talks to the API over HTTP.

```bash
npm run cli -- <command>                                       # from the repo, no build
npm run build -w @loopway/cli && npm link -w @loopway/cli      # or put `loopway` on your PATH
```

```bash
loopway config                         # sets the API URL (default https://loopway.craftmill.dev) and, optionally, a GitHub bot; skip it for the defaults
loopway login                          # emails you a one-time code, trades it for a 30-day session token, saves it (new emails get an account)
loopway whoami
loopway clear-config                   # deletes ~/.loopway/config.json

loopway inbox create                   # interactive: name → source → events → secret → confirm
loopway inbox list
loopway inbox show <inbox>             # webhook setup + pending/locked/processed counts
loopway inbox update <inbox> [--name n] [--events a,b] [--secret s] [--schema file.json]   # with no flags in a terminal, asks for the secret

loopway events list <inbox> [--status pending] [--type 'com.github.pull_request.*'] [--limit 20] [--all]
loopway events get  <inbox> <event> [--data]
loopway events next <inbox> [--ttl 600]
loopway events lock <inbox> <event> [--ttl 600]
loopway events unlock <inbox> <event>
loopway events done <inbox> <event>

loopway bots create --name dev --kind github-threads --inbox <inbox>[,<inbox>]
loopway bots list
loopway bots show <bot>
loopway bots update <bot> [--name n] [--inbox a,b]   # --inbox replaces the bot's inboxes
loopway bots delete <bot>
loopway bots messages <bot> [--limit 20]            # what the bot would read next
loopway bots run [--max 3] [--interval 5] [--ttl 3600] [--no-tui]   # run your bots (see below)
```

- `<inbox>` is an inbox id or its exact name; `<bot>` is a bot id or its exact name.
- Every read command takes `--json` for the raw API response. `events next --json` prints nothing when the inbox is empty.
- `inbox create` skips any prompt whose flag is given (`--name`, `--source`, `--events push,pull_request`, `--secret`, `--schema file.json` for `loopway` inboxes); without a terminal it runs from flags alone. For sources whose sender makes the secret (`vercel`, `granola`) it doesn't ask for one: add the webhook in the sender, then paste the secret it shows with `loopway inbox update <inbox>` (or on the inbox's dashboard page).
- Credentials live in `~/.loopway/config.json` (`{ "api_url", "api_key" }`, plus an optional `github` bot for [bot sessions](#acting-as-a-github-bot), mode 0600). `LOOPWAY_API_URL` / `LOOPWAY_API_KEY` override it, e.g. in CI. The URL defaults to `https://loopway.craftmill.dev`.
- Lock tokens from `next`/`lock` are kept in `~/.loopway/locks.json` until they expire, so `lock` (renew), `unlock` and `done` on the same machine don't need `--token`.
- A bot reads messages from one or more inboxes (see [Bots](#bots)). `--kind` must be one this CLI knows how to run: `github-threads`. `loopway bots run` runs them (see [Running bots](#running-bots)).

### Running bots

```bash
loopway bots run [--max 3] [--interval 5] [--ttl 3600] [--no-tui]   # run your bots (q or Ctrl-C to stop)
```

`loopway bots run` runs every bot on your account whose kind this CLI knows (`github-threads`), in the current directory. With no bots, it says how to create one and exits. One process runs all your bots, and `--max` is shared across them, since it caps the load on this machine.

In a terminal, `loopway bots run` takes over the screen. The header names the bots this runner holds, and any it skipped because another runner holds their lease. Below are four lists: waiting messages (assigned to a session but not delivered yet), working sessions (a run in flight), waiting sessions (active, waiting for their next message) and done sessions (ended, newest first). ↑/↓ moves between sessions, Tab/Shift-Tab jumps between lists, and Enter or → opens a session's transcript, which follows new output until you scroll up (↑/↓, PgUp/PgDn, Home/End). ← goes back to the lists. The dispatcher's latest log line shows at the bottom. Quitting stops the dispatcher and its sessions, as Ctrl-C does. `--no-tui`, or output that isn't a terminal, prints the plain log instead.

**Leasing.** At startup, and every tick, the runner takes or renews each bot's lease (`POST /bots/:id/lease`, held for `--ttl` seconds). A bot leased by another runner is skipped, with one log line, and tried again next tick, so two copies of `loopway bots run` never read the same bot. Quitting releases the leases; a runner that dies leaves its leases to expire.

**Each tick, per leased bot**, every `--interval` seconds:

1. It reads `GET /bots/:id/messages` until there are none.
2. Every message is assigned to a session: the one its issue/PR already belongs to, the issue's session when it's a PR that `Closes #N`, or a new one. Assignment never waits on `--max` or on a running session; an assigned message waits on its session until it can be delivered.
3. The assignments are saved to `threads.json`, then the cursor is moved past them with `POST /bots/:id/cursor`. If the runner dies between the two, the messages come back next tick and are skipped as already assigned.
4. Every session with waiting messages and no run in flight gets them all in one run (`claude -p --permission-mode auto`, then `claude --resume`), oldest first, while `--max` allows. `--max` caps runs in flight, not sessions: a session waiting for its next message doesn't count, so any number can wait.

A thread is an issue and the PRs linked to it, keyed by `owner/repo#number`. A new session starts with the prompt in [`packages/cli/prompts/thread.md`](packages/cli/prompts/thread.md). Bot kinds live in `packages/cli/src/threads/kinds.ts`, a map from kind to how it routes messages and the prompt it uses.

Sessions talk back to the dispatcher over MCP: it serves a `loopway` server on 127.0.0.1 (one URL per session, passed with `--mcp-config`) with two tools:

- `link` adds a PR to the session's thread. Sessions call it right after opening a PR; a PR whose body says `Closes #N` also joins issue N's thread on its own.
- `end` marks the thread finished. The session decides when that is (a close event usually means it, but not always). A later message for the thread resumes it and makes it active again.

Delivery doesn't touch the inbox's events: they aren't locked or marked processed, and a session never marks them done. They're context for the thread, and `end` is what finishes it. A delivery lists each message's id, type, thread key and the command that reads it, `loopway events get <inbox> <message> --data` (a bot can read several inboxes). Sessions are tracked in `~/.loopway/threads.json` by the bot they belong to, with the messages delivered to each and those still waiting (writes take `threads.json.lock`), and each one's transcript (stream-json) is appended to `~/.loopway/threads/<session>.log`. Sessions written by older versions, which ran one inbox, are adopted by the bot that reads that inbox the first time it runs, so threads in flight carry on.

The inbox's GitHub webhook needs `pull_request`, `pull_request_review` and `pull_request_review_comment` (as well as `issues` and `issue_comment`) for reviews to reach sessions.

#### Acting as a GitHub bot

By default sessions use your own `gh` login and git credentials, so their comments, PRs and commits look like yours. To have them act as a bot user instead, add the bot's token and git identity. The token can be a fine-grained PAT with contents, issues and pull requests read/write on an org that allows them, or a classic PAT with `repo` scope (needed for repos where the bot is only a collaborator). Set them with `loopway config`, which prompts for each one in a terminal (an empty answer keeps the saved value), or pass flags:

```sh
loopway config --github-token github_pat_... --github-name loopway-bot --github-email 12345+loopway-bot@users.noreply.github.com
```

They're saved as the `github` block in `~/.loopway/config.json`:

```json
{
  "api_url": "...",
  "api_key": "...",
  "github": { "token": "github_pat_...", "name": "loopway-bot", "email": "12345+loopway-bot@users.noreply.github.com" }
}
```

`LOOPWAY_GITHUB_TOKEN`, `LOOPWAY_GITHUB_NAME` and `LOOPWAY_GITHUB_EMAIL` override it. Set all three or none; `loopway config` won't save only some. `loopway login` keeps the `github` block. Each session then gets:

- `GH_TOKEN` and `GITHUB_TOKEN`, so `gh` comments and opens PRs as the bot, and other tools that read `GITHUB_TOKEN` don't get a token you exported;
- a git credential helper for `https://github.com` that answers with the bot's token, replacing your own helpers there, with `git@github.com:` remotes rewritten to HTTPS so pushes use it too;
- `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to the bot.

The git settings are passed as `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, so nothing is written to your git config.

## API

Users are created with `loopway login` (see above). Every endpoint except `/webhooks/*`, `/health`, `/api` and the web pages takes `Authorization: Bearer <token>`. The token is a session JWT from `loopway login`, valid 30 days.
Errors look like `{ "error": { "code": "...", "message": "..." } }`.

### Users

|                                     |                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login` `{email}`        | Email an 8-character code (valid 10 min) via Resend. Always `202`. At most one email per address per 10 minutes; asking again sooner sends nothing.                                    |
| `POST /auth/verify` `{email, code}` | Trade the code for a session token (`201 {token, expires_at, user, created}`). Single use, 5 guesses. If the email has no user yet, creates one (named after the part before the `@`). |
| `GET /me`                           | Current user.                                                                                                                                                                          |

### Inboxes

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

### Webhook ingestion

`POST /webhooks/:inboxId` — no API key; authenticated by the source (GitHub: `X-Hub-Signature-256` HMAC-SHA256; Vercel: `X-Vercel-Signature` HMAC-SHA1; Granola: Standard Webhooks `webhook-signature`, timestamp within 5 minutes; Loopway: `Authorization: Bearer <inbox token>`).

- `202 {id, duplicate:false}` stored
- `200 {id, duplicate:true}` redelivery of an event already stored (same CloudEvent `source`+`id`)
- `200 {ignored:true, reason}` `ping`
- `400` malformed body (for Loopway, one that doesn't match the inbox schema) · `401` bad/missing signature or token (or, for Vercel and Granola, no secret set yet) · `404` unknown inbox · `415` unsupported content type · `422` event type not in `config.events` (GitHub shows it as a failed delivery and doesn't retry it; Vercel retries any non-2xx for up to 24 hours; Granola retries only 408, 429 and 5xx)

GitHub → CloudEvent mapping follows the [CloudEvents GitHub adapter spec](https://github.com/cloudevents/spec/blob/main/cloudevents/adapters/github.md): `id` = `X-GitHub-Delivery`, `type` = `com.github.<event>.<action>`, `source`/`subject`/`time` per event, `data` = payload.

Vercel → CloudEvent: `id` = body `id`, `type` = `com.vercel.<type>` (e.g. `com.vercel.deployment.error`), `source` = the project's API URL (`https://api.vercel.com/v9/projects/<id>`, else the team's), `subject` = what the event is about (the deployment id for `deployment.*`, the project id for `project.*`, the domain name for `domain.*`, …, else the event id, so every event has one), `time` = `createdAt`, `data` = the whole body.

Granola → CloudEvent: `id` = `webhook-id`, `type` = `ai.granola.<event_type>` (e.g. `ai.granola.note.generated`), `source` = `https://public-api.granola.ai/v1/notes/<note_id>`, `subject` = `note_id`, `time` = `occurred_at`, `data` = payload.

Loopway → CloudEvent: `id` = a new UUID per message (so nothing is deduped), `type` = body `type` (a non-empty string), `source` = the inbox's webhook URL, `subject` = `<type>/<id>` with body `id` (a string or number naming what the message is about, so every message about it shares a subject), `time` = receive time, `data` = body `data`.

### Events

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

### Consumer loop

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

### Bots

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

## Layout

```
packages/web/
  src/index.ts          Vercel entry (default-exports the Hono app)
  src/api.ts            routes, auth, serialization
  src/ui.ts             web UI: home, /login, /dashboard (HTML + vanilla JS + styles)
  src/store.ts          all SQL
  src/db/               driver adapter (PGlite | postgres.js) + migrations
  src/sources/          one file per source adapter (github.ts, granola.ts, vercel.ts); index.ts registers them in a SourceRegistry
  src/cloudevents.ts    CloudEvent type + validation
  scripts/              dev server, migrate
  test/api.test.ts      end-to-end tests (TEST_DATABASE_URL=... to run against real Postgres)
  test/sources/         one webhook test file per source
packages/cli/
  src/index.ts          `loopway` entry: error handling + exit codes
  src/program.ts        commands and flags (commander)
  src/commands/         auth, inboxes (incl. the create TUI, @clack/prompts), events, bots, threads
  src/client.ts         typed API client
  src/config.ts         ~/.loopway/config.json
  src/locks.ts          ~/.loopway/locks.json
  src/mcp.ts            minimal MCP server (HTTP, localhost) the bots dispatcher serves to its sessions
  src/threads/          `loopway bots run`: dispatcher.ts (lease, read, assign, deliver), kinds.ts (bot kind → route + prompt),
                        routing.ts (github-threads: message → session), store.ts (~/.loopway/threads.json + its lock),
                        tools.ts (MCP link/end), agent.ts (claude -p),
                        tui.tsx (the Ink TUI), transcript.ts (stream-json log → readable lines)
  prompts/thread.md     the prompt every thread session starts with
  test/cli.test.ts      runs commands against the real API app in-process
  test/tui.test.tsx     renders the threads TUI with ink-testing-library
```

### Adding a source

1. Add `packages/web/src/sources/<type>.ts` implementing `SourceAdapter` (`types.ts`):
   - what clients show: `label`, `description`, common `events`, `secret` (`{from: "loopway", minLength}` if loopway makes it, `{from: "sender"}` if the sender shows one after the webhook is added) and `webhookSettings`
   - `parseConfig` (validate + defaults), `publicConfig`, optional `setup`, and `receive(headers, rawBody) → event | ignored | rejected`
2. Add it to the list in `packages/web/src/sources/index.ts`.
3. Add `packages/web/test/sources/<type>.test.ts` (`test/helpers.ts` gives it an app and database) and its config and CloudEvent mapping to this README.

Nothing else names a source: the API, `loopway inbox create` and the dashboard build their forms from `GET /sources`, and the inbox page offers a secret form for any `sender` source.
