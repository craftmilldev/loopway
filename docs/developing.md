# Developing loopway

- **Stack:** TypeScript + [Hono](https://hono.dev), zero-config on Vercel.
- **DB:** Postgres 17 everywhere, through [postgres.js](https://github.com/porsager/postgres). Locally a Docker container (`docker-compose.yml`); on Vercel, [Neon](https://neon.tech) via `DATABASE_URL`. Tests run against the same local Postgres, so they exercise the engine that is deployed.
- **Data types:** `User` → owns `Inbox`es → which receive `Message`s; a `Bot` reads the messages of one or more inboxes.
- **Sources:** `github`, `granola`, `linear`, `loopway`, `vercel` (more can be added in `packages/sources/src/`, see [Adding a source](#adding-a-source)).
- **Packages:** npm workspaces — [`packages/web`](../packages/web) (the server) and [`packages/cli`](../packages/cli) (the `loopway` command, a client of the [API](api.md)).

## Run locally

```bash
npm install                   # installs every workspace
npm run db:up                 # starts the local Postgres (needs Docker); `npm run db:down` stops it
cp packages/web/.env.example packages/web/.env
npm run dev                   # http://localhost:3000, against the local Postgres (DATABASE_URL in .env)
npm test                      # every workspace; each test file gets its own throwaway database
npm run lint                  # ESLint, with type-aware rules
npm run format                # Prettier; CI runs format:check
npm run update                # git pull, npm install, npm run build
```

Root scripts forward to the workspaces (`lint` and `format` run once over the whole repo); `npm run <script> -w @loopway/web` (or `@loopway/cli`) runs one directly.

Create a user with `loopway login` (the CLI creates the user if the email is new).

To receive real GitHub webhooks locally, expose the port (e.g. `cloudflared tunnel --url localhost:3000`) and set `PUBLIC_BASE_URL` to the tunnel URL.

## Deploy (Vercel + Neon)

1. In Neon → Connect, copy both connection strings: the **direct** one and the **pooled** one (host contains `-pooler`).
2. Deploys run migrations themselves (step 4). To migrate by hand, run `DATABASE_URL='postgresql://...' npm run db:migrate` against the direct URL, or put the direct URL in `packages/web/.env.production` (gitignored; `db:migrate` reads it ahead of `.env`), which also makes `npm run update` migrate prod
3. In Vercel, import the repo, set **Root Directory** to `packages/web`, and set env vars: `DATABASE_URL_POOLED` (the pooled URL), `DATABASE_URL` (the direct URL), `TOKEN_SECRET` (signs session tokens; `openssl rand -hex 32`), and optionally `PUBLIC_BASE_URL`. The server uses `DATABASE_URL_POOLED` when it's set. Craftmill's own deployment also sets `SOURCE_REQUEST_URL` and `SOURCE_REQUEST_TOKEN` (the webhook URL and inbox token of its `source-requests` loopway inbox); without them the dashboard doesn't offer source requests.
4. Deploy. Vercel picks up `packages/web/src/index.ts` as a Hono app automatically. The build command in `packages/web/vercel.json` runs `npm run db:migrate` against that environment's `DATABASE_URL` and then `npm run build` to bundle the web UI into `packages/web/public/`, so every deploy (production and preview) migrates before the new code goes live. If a migration fails, the build fails and the previous deployment stays live. Builds that start together against one database queue on an advisory lock, so none of them fails on a migration another already applied. Each applied migration's SQL is checksummed, and a build fails if a migration was edited after it ran on that database (add a new migration instead, or reset a throwaway preview database). Migrations applied before checksums existed are recorded as-is on the next run. For previews you would rather wipe than keep, set `MIGRATE_RESET=drop-all-data` on Vercel's **Preview** environment: every deploy there then drops the `loopway` schema (all data) before migrating, so editing a migration in place just works. The script only honours it when `VERCEL_ENV` is `preview`, so it fails the build on Production and custom environments and refuses to run from your machine, but it will wipe whatever database that environment's `DATABASE_URL` points at, so never set it where the data matters. `npm run dev` runs the same migrate, so editing a migration you already applied locally also stops dev with this error; reset the local database with `docker compose -p loopway down -v && npm run db:up`.

   Two rules follow. First, **a Preview environment must not use the production database**: a preview would apply that branch's unmerged migrations to production, and they stay there if the PR changes or closes. Give previews their own `DATABASE_URL` (the direct URL), and note that previews sharing one database share its migrations. Second, **migrations must be backward compatible**: they run before the new code is live, so for a short window the old deployment runs against the new schema. Add columns and tables; don't drop or rename in the same release. The app serves `app.js` and `app.css` itself, since Vercel's CDN only serves the files in `public/` that are committed.
5. Create users with `loopway login` pointed at your deployment (`loopway config` sets the URL).

Optionally set `POSTHOG_API_KEY` (and `POSTHOG_HOST` for EU or self-hosted PostHog; an `eu.*` host also points the `/api/ingest` reverse proxy at PostHog EU) to send product metrics, from the server and from the web UI in the browser; without a key nothing is sent. The CLI reads the same two variables (its host can also be `posthog_host` in `~/.loopway/config.json`; the default is this API's `/api/ingest` proxy), and stays silent when `DO_NOT_TRACK` or `LOOPWAY_TELEMETRY=0` is set. Events: web `webhook_received` (by source and outcome), `api_error` (by code), `login_requested`, `signed_up`, `logged_in`, `inbox_created`; CLI `cli_command`, `cli_error`, `bot_session_stopped` (by how it stopped). The CLI identifies the logged-in user (from its session token), or a random id in `~/.loopway/install-id` before login.

Tables live in a `loopway` schema (not `public`) with RLS enabled and no policies, so a Data API (Neon's is opt-in) can't reach them.

## Web UI

The same Hono app serves a small web UI: `/` (how to use loopway), `/login` (same email-code flow as the CLI; the session token is kept in `localStorage`), `/dashboard` (your bots with a create form and where each is running, your runners, and your inboxes with a create form; where source requests are on, the inbox form's Source list ends with "Something else…", which asks for a new source type instead), `/dashboard/inboxes/<inbox>` (messages with their `seq`, newest first, expandable JSON, a marker where each bot reading the inbox has read up to, and, for sources whose sender makes the secret, like Vercel, Linear and Granola, a form to paste it; `/dashboard/<inbox>` redirects there), `/dashboard/bots/<bot>` (inboxes, cursor and lease holder; rename, change inboxes or delete the bot; its threads with owner and message counts, and a Release button for threads whose runner is offline) and `/dashboard/bots/<bot>/threads/<thread>` (subjects, flags, owner, and the waiting, inflight and delivered messages). The dashboard only reads threads and runners; transcripts stay on the runner. `GET /api` is a bare health check, and every JSON route lives under `/api`.

The pages are a React app in `packages/web/client/`. The homepage copy is markdown in [`packages/web/content/home.md`](../packages/web/content/home.md). `npm run build -w @loopway/web` bundles the app with esbuild into `packages/web/public/` (git-ignored); `npm run dev` rebuilds it on change and serves it.

## Layout

```
packages/sources/
  src/                  one file per source (github.ts, granola.ts, linear.ts, vercel.ts): its webhook adapter, a function of the
                        SourceDeps (ids, secrets, CloudEvent validation) the host injects, and optionally its rule helpers;
                        index.ts registers them (createSources)
packages/web/
  src/sources.ts        the sources, wired to the server's real SourceDeps
  src/cloudevents.ts    CloudEvent validation
  src/index.ts          Vercel entry (default-exports the Hono app)
  src/api.ts            routes, auth, serialization
  src/ui.ts             web UI: home, /login, /dashboard (HTML + vanilla JS + styles)
  src/store.ts          all SQL
  src/db/               postgres.js adapter + migrations; testing.ts opens a throwaway test database
  scripts/              dev server, migrate
  test/api.test.ts      end-to-end tests (TEST_DATABASE_URL points at a different Postgres server)
  test/sources/         one webhook test file per source
packages/cli/
  src/index.ts          `loopway` entry: error handling + exit codes
  src/program.ts        commands and flags (commander)
  src/commands/         auth, inboxes (incl. the create TUI, @clack/prompts), messages, bots, bots-run (`loopway bots run`)
  src/client.ts         typed API client
  src/config.ts         ~/.loopway/config.json
  src/mcp.ts            minimal MCP server (HTTP, localhost) the bots dispatcher serves to its sessions
  src/bots/             `loopway bots run`: dispatcher.ts (lease, read, assign, deliver),
                        rules.ts (CEL assign rules: message → thread, with the sources' rule helpers),
                        tools.ts (MCP link/end), agent.ts (claude -p),
                        tui.tsx (the Ink TUI), transcript.ts (stream-json log → readable lines)
  (bot presets live in packages/presets/src: github-threads has its prompt and starting rules)
  test/cli.test.ts      runs commands against the real API app in-process
  test/tui.test.tsx     renders the threads TUI with ink-testing-library
```

### Adding a source

1. Add `packages/sources/src/<type>.ts` exporting a function from `SourceDeps` to a `SourceAdapter` (`types.ts`); use the injected `newSecret`, `uuidv7`, `safeEqual` and `makeCloudEvent` rather than importing your own:
   - what clients show: `label`, `description`, common `events`, `secret` (`{from: "loopway", minLength}` if loopway makes it, `{from: "sender"}` if the sender shows one after the webhook is added) and `webhookSettings`
   - optional `rules`: the CEL helpers (`<type>_<helper>`) bot rules can call on its event types
   - `parseConfig` (validate + defaults), `publicConfig`, optional `setup`, and `receive(headers, rawBody) → event | ignored | rejected`
2. Add it to `createSources` in `packages/sources/src/index.ts`.
3. Add `packages/web/test/sources/<type>.test.ts` (`test/helpers.ts` gives it an app and database) and write `docs/sources/<type>.md` (config, setup in the sender, delivery rules, CloudEvent mapping) like the [existing ones](sources/).

Nothing else names a source: the API, `loopway inbox create` and the dashboard build their forms from `GET /sources`, and the inbox page offers a secret form for any `sender` source.
