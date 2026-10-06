# loopway

Accepts webhooks from defined sources, stores them as [CloudEvents](https://github.com/cloudevents/spec) in a per-user **inbox**, and exposes an API to list, lock, claim, and mark events processed.

- **Stack:** TypeScript + [Hono](https://hono.dev), zero-config on Vercel.
- **DB:** Postgres everywhere. Locally [PGlite](https://pglite.dev) (embedded, no server); on Vercel, [Neon](https://neon.tech) via `DATABASE_URL`. Same SQL on both.
- **Data types:** `User` → owns `Inbox`es → which receive `Event`s.
- **Sources:** `github` (more can be added in `packages/web/src/sources/`).
- **Packages:** npm workspaces — [`packages/web`](packages/web) (the server) and [`packages/cli`](packages/cli) (the `loopway` command, a client of the API).

## Run locally

```bash
npm install                   # installs every workspace
cp packages/web/.env.example packages/web/.env
npm run dev                   # http://localhost:3000, data in packages/web/.data/pglite
npm test                      # every workspace, in-memory PGlite
```

Root scripts forward to the workspaces; `npm run <script> -w @loopway/web` (or `@loopway/cli`) runs one directly.

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

The same Hono app serves a small web UI: `/` (how to use loopway), `/login` (same email-code flow as the CLI; the session token is kept in `localStorage`), `/dashboard` (your inboxes and a create form) and `/dashboard/<inbox>` (events, newest first, expandable JSON, hide-processed toggle). `GET /api` is a bare health check.

The pages are a React app in `packages/web/client/`. The homepage copy is markdown in [`packages/web/content/home.md`](packages/web/content/home.md). `npm run build -w @loopway/web` bundles the app with esbuild into `packages/web/public/` (git-ignored); `npm run dev` rebuilds it on change and serves it.

## CLI

`loopway` lives in `packages/cli` and talks to the API over HTTP.

```bash
npm run cli -- <command>                                       # from the repo, no build
npm run build -w @loopway/cli && npm link -w @loopway/cli      # or put `loopway` on your PATH
```

```bash
loopway login                          # emails you a one-time code, trades it for a 30-day session token, saves it (new emails get an account)
loopway config                         # or paste an existing API URL + key; verifies with GET /me
loopway whoami
loopway clear-config                   # deletes ~/.loopway/config.json

loopway inbox create                   # interactive: name → source → events → secret → confirm
loopway inbox list
loopway inbox show <inbox>             # webhook setup + pending/locked/processed counts

loopway events list <inbox> [--status pending] [--type 'com.github.pull_request.*'] [--limit 20] [--all]
loopway events get  <inbox> <event> [--data]
loopway events next <inbox> [--ttl 600]
loopway events lock <inbox> <event> [--ttl 600]
loopway events unlock <inbox> <event>
loopway events done <inbox> <event>
```

- `<inbox>` is an inbox id or its exact name.
- Every read command takes `--json` for the raw API response. `events next --json` prints nothing when the inbox is empty.
- `inbox create` skips any prompt whose flag is given (`--name`, `--source`, `--events push,pull_request`, `--secret`); without a terminal it runs from flags alone.
- Credentials live in `~/.loopway/config.json` (`{ "api_url", "api_key" }`, mode 0600). `LOOPWAY_API_URL` / `LOOPWAY_API_KEY` override it, e.g. in CI. The URL defaults to `https://loopway.craftmill.dev`.
- Lock tokens from `next`/`lock` are kept in `~/.loopway/locks.json` until they expire, so `lock` (renew), `unlock` and `done` on the same machine don't need `--token`.

### Threads

```bash
loopway threads <inbox> [--max 3] [--interval 30] [--ttl 3600] [--no-tui]   # run the dispatcher (q or Ctrl-C to stop)
```

In a terminal, `loopway threads` takes over the screen with four lists: raw events (pending, not yet handed to a session), working sessions (a run in flight), waiting sessions (active, waiting for their next event) and done sessions (ended, newest first). ↑/↓ moves between sessions, Tab/Shift-Tab jumps between lists, and Enter or → opens a session's transcript, which follows new output until you scroll up (↑/↓, PgUp/PgDn, Home/End). ← goes back to the lists. The dispatcher's latest log line shows at the bottom. Quitting stops the dispatcher and its sessions, as Ctrl-C does. `--no-tui`, or output that isn't a terminal, prints the plain log instead.

`loopway threads` runs one headless Claude Code session (`claude -p --permission-mode auto`) per thread, in the current directory. A thread is an issue and the PRs linked to it, keyed by `owner/repo#number`. Every `--interval` seconds it lists the inbox's pending events:

- An event for a known issue/PR is locked and handed to that thread's session (`claude --resume`). Sessions run in parallel; one that is still running gets its new events together once its current run exits.
- Any other event starts a new session with the prompt in [`packages/cli/prompts/thread.md`](packages/cli/prompts/thread.md) (`{{inbox}}` is filled in).
- `--max` is a hard cap on sessions holding a slot: every active session, plus an ended one until its current run exits. Events that would need another slot stay pending.

Sessions talk back to the dispatcher over MCP: it serves a `loopway` server on 127.0.0.1 (one URL per session, passed with `--mcp-config`) with two tools:

- `link` adds a PR to the session's thread. Sessions call it right after opening a PR; a PR whose body says `Closes #N` also joins issue N's thread on its own.
- `end` marks the thread finished, freeing its slot once the current run exits. The session decides when that is (a close event usually means it, but not always). A later event for the thread resumes it and makes it active again.

Every event delivered to a session stays locked, renewed each poll for `--ttl` seconds, until the session marks it done. Sessions are tracked in `~/.loopway/threads.json` (including the events they own, so a restarted dispatcher keeps renewing them; writes take `threads.json.lock`, so dispatchers for several inboxes can share it) and each one's transcript (stream-json) is appended to `~/.loopway/threads/<session>.log`.

The inbox's GitHub webhook needs `pull_request`, `pull_request_review` and `pull_request_review_comment` (as well as `issues` and `issue_comment`) for reviews to reach sessions.

## API

Users are created with `loopway login` (see above). Every endpoint except `/webhooks/*`, `/health`, `/api` and the web pages takes `Authorization: Bearer <token>`. The token is a session JWT from `loopway login`, valid 30 days.
Errors look like `{ "error": { "code": "...", "message": "..." } }`.

### Users

| | |
|---|---|
| `POST /auth/login` `{email}` | Email an 8-character code (valid 10 min) via Resend. Always `202`. At most one email per address per 10 minutes; asking again sooner sends nothing. |
| `POST /auth/verify` `{email, code}` | Trade the code for a session token (`201 {token, expires_at, user, created}`). Single use, 5 guesses. If the email has no user yet, creates one (named after the part before the `@`). |
| `GET /me` | Current user. |

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
- `200 {ignored:true, reason}` `ping`
- `401` bad/missing signature · `404` unknown inbox · `422` event type not in `config.events` (GitHub shows it as a failed delivery and doesn't retry it)

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

## Layout

```
packages/web/
  src/index.ts          Vercel entry (default-exports the Hono app)
  src/api.ts            routes, auth, serialization
  src/ui.ts             web UI: home, /login, /dashboard (HTML + vanilla JS + styles)
  src/store.ts          all SQL
  src/db/               driver adapter (PGlite | postgres.js) + migrations
  src/sources/          source adapters; github.ts is the first
  src/cloudevents.ts    CloudEvent type + validation
  scripts/              dev server, migrate
  test/api.test.ts      end-to-end tests (TEST_DATABASE_URL=... to run against real Postgres)
packages/cli/
  src/index.ts          `loopway` entry: error handling + exit codes
  src/program.ts        commands and flags (commander)
  src/commands/         auth, inboxes (incl. the create TUI, @clack/prompts), events, threads
  src/client.ts         typed API client
  src/config.ts         ~/.loopway/config.json
  src/locks.ts          ~/.loopway/locks.json
  src/mcp.ts            minimal MCP server (HTTP, localhost) the threads dispatcher serves to its sessions
  src/threads/          `loopway threads`: dispatcher.ts (the poll loop), routing.ts (event → session),
                        store.ts (~/.loopway/threads.json + its lock), tools.ts (MCP link/end), agent.ts (claude -p),
                        tui.tsx (the Ink TUI), transcript.ts (stream-json log → readable lines)
  prompts/thread.md     the prompt every thread session starts with
  test/cli.test.ts      runs commands against the real API app in-process
  test/tui.test.tsx     renders the threads TUI with ink-testing-library
```

### Adding a source

Implement `SourceAdapter` (`packages/web/src/sources/types.ts`): `parseConfig` (validate + defaults), `publicConfig`, optional `setup`, and `receive(headers, rawBody) → event | ignored | rejected`. Register it in `packages/web/src/sources/index.ts`. `loopway inbox create` lists it automatically and asks for its config as JSON; add a dedicated prompt flow in `packages/cli/src/commands/inboxes.ts` if it deserves one.
