# Developing loopway

- **Stack:** TypeScript + [Hono](https://hono.dev), zero-config on Vercel.
- **DB:** Postgres 17 everywhere, through [postgres.js](https://github.com/porsager/postgres). Locally a Docker container (`docker-compose.yml`); on Vercel, [Neon](https://neon.tech) via `DATABASE_URL`. Tests run against the same local Postgres, so they exercise the engine that is deployed.
- **Data types:** `User` → owns `Inbox`es → which receive `Message`s; a `Bot` reads the messages of one or more inboxes.
- **Sources:** `github`, `granola`, `linear`, `loopway`, `resend`, `schedule`, `vercel` (more can be added in `packages/sources/src/`, see [Adding a source](#adding-a-source)).
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

Login codes are emailed through Resend when `RESEND_API_KEY` is set, from the address in `EMAIL_FROM`, which is then required (e.g. `loopway <login@example.com>`; its domain must be verified in Resend). Without a key they are printed to the server's console. A failed send records a `login_email_failed` metric.

To receive real GitHub webhooks locally, expose the port (e.g. `cloudflared tunnel --url localhost:3000`) and set `PUBLIC_BASE_URL` to the tunnel URL.

## Deploy (Vercel + Neon)

1. In Neon → Connect, copy both connection strings: the **direct** one and the **pooled** one (host contains `-pooler`).
2. Nothing to run by hand: the Vercel build applies pending migrations before it bundles (see step 4). To migrate from your machine instead, `DATABASE_URL='postgresql://...' npm run db:migrate` against the direct URL, or put it in `packages/web/.env.production` (gitignored; `db:migrate` reads it ahead of `.env`), which also makes `npm run update` migrate prod.
3. In Vercel, import the repo, set **Root Directory** to `packages/web`, and set env vars: `DATABASE_URL_UNPOOLED` (the direct URL, what the build migrates) and `DATABASE_URL` (the pooled URL; Neon's integration sets both under these names), `TOKEN_SECRET` (signs session tokens; `openssl rand -hex 32`), and optionally `PUBLIC_BASE_URL` (also the URL `/llms.txt` names), `SELF_HOSTED=1` (`/` redirects to `/login` instead of serving the landing page) and `MIN_CLI_VERSION` (see [Releasing the CLI](#releasing-the-cli)). The server uses `DATABASE_URL_POOLED` when it's set, else `DATABASE_URL`; the build migrates `DATABASE_URL_UNPOOLED`, else `DATABASE_URL`. Existing setups with `DATABASE_URL_POOLED` (pooled) and `DATABASE_URL` (direct) keep working unchanged. Craftmill's own deployment also sets `CRAFTMILL_ENTERPRISE_LICENSE` (any non-empty value; it turns on the routes under `ee/`, which `ee/LICENSE` covers) plus `SOURCE_REQUEST_URL` and `SOURCE_REQUEST_TOKEN` (the webhook URL and inbox token of its `source-requests` loopway inbox); without all three the dashboard doesn't offer source requests.
4. Deploy. Vercel picks up `packages/web/src/index.ts` as a Hono app automatically, and runs `npm run build`, which applies pending migrations (a failure fails the build, so the previous deployment stays live; it records `migrations_applied` or `migrations_failed`) and then bundles the web UI into `packages/web/public/`. The app serves `app.js` and `app.css` itself, since Vercel's CDN only serves the files in `public/` that are committed. Only `main` deploys: `packages/web/vercel.json` turns off preview deployments for every other branch.
5. Create users with `loopway login` pointed at your deployment (`loopway config update` sets the URL).

Optionally set `SCHEDULE_OPTIONS` (`hour`, `day` or `hour,day`; default `day`) to choose which schedule options the deploy offers: Vercel Hobby only runs daily crons, so hourly also needs an hourly cron in `packages/web/vercel.json` on Pro (see [Schedule](sources/schedule.md)). Optionally set `POSTHOG_API_KEY` (and `POSTHOG_HOST` for EU or self-hosted PostHog; an `eu.*` host also points the `/api/ingest` reverse proxy at PostHog EU) to send product metrics, from the server and from the web UI in the browser; without a key nothing is sent. The CLI reads the same two variables (its host can also be `posthog_host` in `~/.loopway/config.json`; the default is this API's `/api/ingest` proxy), and stays silent when `DO_NOT_TRACK` or `LOOPWAY_TELEMETRY=0` is set. Events: web `webhook_received` (by source and outcome), `schedule_message` (by outcome), `schedule_ticked`, `schedule_tick_rejected` (by reason: `bad_token`, `unset` or `option_disabled`, the last with the option), `schedule_option_rejected` (by option and action: create or update), `api_error` (by code and `cli_version`), `install_sh_served`, `install_sh_missing`, `login_requested`, `signed_up`, `logged_in`, `inbox_created`, `migrations_applied` (with the count), `migrations_failed`; CLI `cli_command`, `schedule_updated` (by how: flags, file or interactive), `schedule_update_failed`, `inbox_update_rejected` (by source and reason), `cli_error`, `cli_update` (by outcome), `bot_session_stopped` (by how it stopped). The CLI identifies the logged-in user (from its session token), or a random id in `~/.loopway/install-id` before login.

Tables live in a `loopway` schema (not `public`) with RLS enabled and no policies, so a Data API (Neon's is opt-in) can't reach them.

## Releasing the CLI

The CLI is released on its own, separately from the web deploy, and nobody has to cut releases by hand. When CI passes on a push to main, `.github/workflows/release-cli.yml` checks whether anything the CLI ships has changed since the last `cli-v*` tag: `packages/cli` or a `@loopway/*` package listed in its `dependencies`, not counting their `test/` folders and markdown. If something has, it releases the next version. A failed or skipped release is picked up by the next push, because it compares against the last tag, not the last commit.

The next version is a patch bump of the last tag (`0.3.0` → `0.3.1`), so `packages/cli/package.json` doesn't need to change for a release. For a minor or major release, raise the version in `packages/cli/package.json` above the last tag (for example to `0.4.0`) and merge it. That version is used instead, and later patches count up from it. Between releases the version in `packages/cli/package.json` can be behind the released one; the workflow sets the real version before it builds. To retry a release, run the workflow from the Actions tab. It releases nothing when nothing has changed.

The workflow builds, packs `@loopway/cli` with `@loopway/harnesses`, `@loopway/presets`, `@loopway/rules` and `@loopway/palette` as `loopway-cli.tgz`, `loopway-harnesses.tgz`, `loopway-presets.tgz`, `loopway-rules.tgz` and `loopway-palette.tgz`, checks that they install and run, and publishes them as a GitHub release. Nothing goes to npm.

People install with `curl -fsSL https://loopway.craftmill.dev/install.sh | sh` (`packages/web/content/install.sh`), which installs the latest release with `npm install -g`; `LOOPWAY_VERSION=0.3.0` picks another. The script installs the tarballs listed in the release's `manifest.txt` (made by `release-cli.yml`), so a new workspace package only needs adding to the pack step there; releases without a manifest (before 0.3.0) can't be installed this way. It needs Node 22+.

A CLI installed this way updates itself (`src/update.ts`). Before every command it looks up the newest `cli-v*` release (at most once every ten minutes, cached in `~/.loopway/update-check.json`; a failed or slow lookup never blocks the command), downloads `loopway-cli.tgz`, reads its `@loopway/*` dependencies and downloads each as `loopway-<name>.tgz` too (so the update never lists packages itself), `npm install -g`s them together, then runs the command again on the new version. `loopway bots run` checks on every poll too: on finding a newer release it stops taking on work, lets the running sessions finish, releases its leases, updates and starts again. A `426 cli_outdated` from the server forces a check at once, and `loopway update` (`--force` to reinstall the newest release) installs now, skipping the cache and the auto-update setting. A failed install keeps the current version and warns. It's on by default; `loopway config update --auto-update off` (`auto_update: false` in `config.json`) or `LOOPWAY_NO_UPDATE=1` turns it off. A CLI run from a git checkout (anything not under a `node_modules` directory) never updates itself.

The CLI sends its version in an `x-loopway-cli-version` header on every request. The server labels `api_error` events with it as `cli_version` (`none` for requests without it, `unknown` for one that isn't a version), and the CLI's own events carry `cli_version` too. To stop serving old CLIs, set `MIN_CLI_VERSION` (for example `0.2.0`) on the web deploy: older CLIs then get `426 cli_outdated`, whose message says how to update. Unset, no CLI is turned away. CLIs built before the header existed send none, so `MIN_CLI_VERSION` never turns them away; it only applies to releases that send their version. The web app deploys on merge, so keep new API behavior working with the previous CLI release until the minimum is raised.

## Web UI

The same Hono app serves a small web UI: `/` (how to use loopway), `/login` (same email-code flow as the CLI; the session token is kept in `localStorage`), `/<org>` (the org's bots with a create form and where each is running, your runners, and your inboxes with a create form; where source requests are on, the inbox form's Source list ends with "Something else…", which asks for a new source type instead), `/<org>/inboxes/<inbox>` (messages with their `seq`, newest first, expandable JSON, a marker where each bot reading the inbox has read up to, and, for sources whose sender makes the secret, like Vercel, Linear, Granola and Resend, a form to paste it; the old `/dashboard/inboxes/<inbox>` and `/dashboard/<inbox>` redirect there), `/<org>/bots/<bot>` (inboxes, cursor and lease holder; rename, change inboxes or delete the bot; its threads with owner and message counts, and a Release button for threads whose runner is offline) and `/<org>/bots/<bot>/threads/<thread>` (subjects, flags, owner, and the waiting, inflight and delivered messages). Each org has its own address, `/<org-slug>`, and its pages show only that org's bots, runners and inboxes (the list endpoints take `?org=<slug>` for this; a slug you aren't a member of is a `404`, as is the page). The header's org switcher moves between your orgs and the last one you used is remembered in the browser. `/dashboard/...` still works: it redirects to the same page under the org that owns the bot or inbox it names, else your last-used org. The dashboard only reads threads and runners; transcripts stay on the runner. `GET /api` is a bare health check, and every JSON route lives under `/api`.

The pages are a React app in `packages/web/client/`. The homepage copy is markdown in [`packages/web/content/home.md`](../packages/web/content/home.md). `/llms.txt` (for tools like Codex and Claude Code) is served from [`packages/web/content/llms.txt`](../packages/web/content/llms.txt); keep it in step with the CLI. `npm run build -w @loopway/web` bundles the app with esbuild into `packages/web/public/` (git-ignored); `npm run dev` rebuilds it on change and serves it.

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
  src/ui.ts             web UI: home, /login, /<org> (HTML + vanilla JS + styles)
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
