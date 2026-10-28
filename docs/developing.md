# Developing loopway

- **Stack:** TypeScript + [Hono](https://hono.dev), zero-config on Vercel.
- **DB:** Postgres 17 everywhere, through [postgres.js](https://github.com/porsager/postgres). Locally a Docker container (`docker-compose.yml`); on Vercel, [Neon](https://neon.tech) via `DATABASE_URL`. Tests run against the same local Postgres, so they exercise the engine that is deployed.
- **Data types:** `Org` → owns `Inbox`es and `Bot`s; an inbox receives `Message`s; a bot reads the messages of one or more inboxes.
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

## Deploy with the Vercel button

The Deploy with Vercel button in the [README](../README.md) clones the repo into your GitHub account, sets **Root Directory** to `packages/web`, adds a Neon database from the Vercel Marketplace and asks for the variables below. Vercel installs from the repo root even with that Root Directory, so the `@loopway/*` workspace packages resolve and the root `postinstall` builds them before the web build runs. The build then applies the migrations. On a fresh deploy `/` redirects to `/login`, where the code arrives by email, or is printed to the function logs when no Resend key is set.

| Env | Set by | What |
| --- | --- | --- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | the Neon product | pooled URL the server uses; direct URL the build migrates |
| `TOKEN_SECRET` | prompt | signs session tokens; `openssl rand -hex 32` |
| `CRON_SECRET` | prompt | Vercel Cron's bearer token for the schedule route; `openssl rand -hex 32` |
| `INBOX_SECRET_KEY` | prompt | encrypts inbox webhook secrets at rest; `openssl rand -base64 32`; keep a copy, losing it loses the secrets |
| `SELF_HOSTED` | prompt | enter `1`, so `/` redirects to `/login` instead of the landing page |
| `RESEND_API_KEY`, `EMAIL_FROM` | prompt | login emails (see [Login email](#login-email-resend-on-the-one-click-deploy)) |

Vercel's clone link has no way to preset a value, so `SELF_HOSTED` is a prompt you answer with `1`. The schedule needs nothing: `SCHEDULE_OPTIONS` defaults to `day,week`, which is all a Hobby account's daily cron can run. Everything else under [Deploy (Vercel + Neon)](#deploy-vercel--neon) is optional (`PUBLIC_BASE_URL`, `POSTHOG_API_KEY`, `MIN_CLI_VERSION`).

The Neon product is the `stores` parameter of the link (`integrationSlug` and `productSlug` `neon`, `protocol` `storage`). Vercel's docs call the parameter `stores`; the same JSON is described as `products` elsewhere.

**Without Resend:** drop `RESEND_API_KEY,EMAIL_FROM` from the `env=` list in the README's button link (and from `envDescription`). Vercel makes every prompted variable required, so a placeholder key would make sends fail. Login codes are then printed to the function logs.

**Bring your own Postgres:** drop the `stores=` parameter from the button link, then set `DATABASE_URL` (the pooled URL, or the only URL if you have no pooler) and `DATABASE_URL_UNPOOLED` (a direct connection; what the build migrates) yourself in Vercel → Settings → Environment Variables before the first deploy, or use the manual steps below. Any Postgres the build and the functions can reach works (17 is what it is tested on); the tables live in a `loopway` schema.

## Point the CLI at a self-hosted deploy

> **Untested:** the commands in this section and the next were written from the code and the Vercel/GitHub docs, not run against a real self-hosted deploy. Run through them once on a fresh deploy and drop this note.

The CLI talks to `https://loopway.craftmill.dev` until told otherwise. For your own deploy:

```bash
curl -fsSL https://loopway.craftmill.dev/install.sh | sh   # installs the CLI (needs Node 22+)
loopway config update --url https://<your-deploy>  # saved in ~/.loopway/config.json
loopway login                                      # emails a one-time code to the deploy's login page
loopway config                                     # shows the URL the CLI now uses
```

Without `--url` the command prompts for it. `loopway config update` only changes the settings you pass (`--posthog-host`, `--auto-update` and the GitHub bot flags are the others), and `loopway clear-config` goes back to the defaults. The URL lives in `~/.loopway/config.json`, so each machine running `loopway bots run` needs the same `config update` first.

`/llms.txt` is how a coding agent learns about the deploy. Every command in it names the deploy: it fills in `PUBLIC_BASE_URL` when that is set, else the origin the request came to. So an agent given `https://<your-deploy>/llms.txt` installs the CLI (your deploy's copy of `install.sh`, which fetches the `craftmilldev/loopway` release) and, once `config update --url` has been run, talks to it. The dashboard's "Create your bot with your agent" prompt links to the same file. Set `PUBLIC_BASE_URL` if the deploy answers on more than one address (a Vercel `*.vercel.app` URL and a custom domain, say), so the file always names the one you want people to use.

The CLI updates itself to the newest release on GitHub (see [Releasing the CLI](#releasing-the-cli)), and your deploy only changes when you update it. A newer CLI can therefore talk to an older deploy; keep the deploy current (below), or turn the CLI's self-update off with `loopway config update --auto-update off` if you want to hold both back together.

## Updating a self-hosted deploy

A deploy made with the Vercel button is a copy of the repo in your GitHub account, not a fork: it has no link to craftmilldev/loopway, so nothing tells you when `main` moves and nothing pulls it in. Updating means getting upstream's commits into your copy's `main` branch. Vercel redeploys on every push to `main`, and the build applies pending database migrations before it bundles (a failure fails the build).

**A copy made by the button** (what the button creates): add this repo as a second remote once, then merge and push.

```bash
git clone https://github.com/<you>/loopway && cd loopway
git remote add upstream https://github.com/craftmilldev/loopway.git   # once
git fetch upstream
git merge upstream/main    # resolve conflicts if you changed files
git push origin main       # Vercel builds, migrates the database and deploys
```

**A fork** (if you forked craftmilldev/loopway on GitHub first and pointed Vercel at the fork): open the fork on GitHub and click **Sync fork** → **Update branch**. The push it makes triggers the build the same way. Fork first if you can: it is the easier path to keep updating. One thing to know before you do: a fork of a public repo is public, and a free GitHub account can't make it private. That is fine for loopway's code, since your secrets are Vercel environment variables, never files in the repo. If you want your copy private, use the button's copy (it can be private) and the `upstream` steps above.

**When the build fails:** if a migration fails, or any step of the build does, Vercel doesn't promote it, so the previous deployment keeps serving and no half-migrated app goes live. Open the failed deployment's build log in Vercel for the error. Each migration runs in its own transaction, so a failing one leaves nothing half-applied; migrations before it stay applied, and the next build picks up from there. Fix the cause (usually a missing env var or a database the build can't reach) and push again, or **Redeploy** from Vercel once it is fixed. A `migrations_failed` metric is recorded when `POSTHOG_API_KEY` is set.

**Breaking changes:** a change that adds a required environment variable or needs a manual step is called out in its pull request's title and description with `[deploy]`, and the env table in [Deploy with the Vercel button](#deploy-with-the-vercel-button) is updated in the same PR. Before updating, look at what is coming with `git log --oneline HEAD..upstream/main` (or the compare view on GitHub) and look for `[deploy]`. Migrations themselves are run for you, so the case to watch is a new env var: add it in Vercel → Settings → Environment Variables before pushing the merge, or the build or the first requests fail.

## Deploy (Vercel + Neon)

The same thing by hand:

1. In Neon → Connect, copy both connection strings: the **direct** one and the **pooled** one (host contains `-pooler`).
2. Nothing to run by hand: the Vercel build applies pending migrations before it bundles (see step 4). To migrate from your machine instead, `DATABASE_URL='postgresql://...' npm run db:migrate` against the direct URL, or put it in `packages/web/.env.production` (gitignored; `db:migrate` reads it ahead of `.env`), which also makes `npm run update` migrate prod.
3. In Vercel, import the repo, set **Root Directory** to `packages/web`, and set env vars: `DATABASE_URL_UNPOOLED` (the direct URL, what the build migrates) and `DATABASE_URL` (the pooled URL; Neon's integration sets both under these names), `TOKEN_SECRET` (signs session tokens; `openssl rand -hex 32`), `INBOX_SECRET_KEY` (encrypts inbox webhook secrets at rest; `openssl rand -base64 32`; keep a copy, since losing it loses the secrets; the build needs it too, because it encrypts any plaintext secrets left from before), and optionally `PUBLIC_BASE_URL` (also the URL `/llms.txt` names), `SELF_HOSTED=1` (`/` redirects to `/login` instead of serving the landing page) and `MIN_CLI_VERSION` (see [Releasing the CLI](#releasing-the-cli)). The server uses `DATABASE_URL_POOLED` when it's set, else `DATABASE_URL`; the build migrates `DATABASE_URL_UNPOOLED`, else `DATABASE_URL`. Existing setups with `DATABASE_URL_POOLED` (pooled) and `DATABASE_URL` (direct) keep working unchanged. Craftmill's own deployment also sets `CRAFTMILL_ENTERPRISE_LICENSE` (any non-empty value; it turns on the routes under `ee/`, which `ee/LICENSE` covers) plus `SOURCE_REQUEST_URL` and `SOURCE_REQUEST_TOKEN` (the webhook URL and inbox token of its `source-requests` loopway inbox); without all three the dashboard doesn't offer source requests.
4. Deploy. Vercel picks up `packages/web/src/index.ts` as a Hono app automatically, and runs `npm run build`, which applies pending migrations (a failure fails the build, so the previous deployment stays live; it records `migrations_applied` or `migrations_failed`) and then bundles the web UI into `packages/web/public/`. The app serves `app.js` and `app.css` itself, since Vercel's CDN only serves the files in `public/` that are committed. Only `main` deploys: `packages/web/vercel.json` turns off preview deployments for every other branch.
5. Create users with `loopway login` pointed at your deployment (`loopway config update` sets the URL).

Optionally set `SCHEDULE_OPTIONS` (any of `hour`, `day`, `week`; default `day,week`) to choose which schedule options the deploy offers: Vercel Hobby only runs daily crons, so hourly also needs an hourly cron in `packages/web/vercel.json` on Pro (see [Schedule](sources/schedule.md)). Optionally set `POSTHOG_API_KEY` (and `POSTHOG_HOST` for EU or self-hosted PostHog; an `eu.*` host also points the `/api/ingest` reverse proxy at PostHog EU) to send product metrics, from the server and from the web UI in the browser; without a key nothing is sent. The CLI reads the same two variables (its host can also be `posthog_host` in `~/.loopway/config.json`; the default is this API's `/api/ingest` proxy), and stays silent when `DO_NOT_TRACK` or `LOOPWAY_TELEMETRY=0` is set. Every event, from the server, the CLI and the browser, carries `product: loopway` (so reports can filter by product across Craftmill's PostHog project) and `app`, the surface, named `<product>-<surface>` like Sesh's (`loopway-api` for the server, `loopway-cli`, `loopway-browser`). Events: web `webhook_received` (by source and outcome), `schedule_message` (by outcome), `schedule_ticked`, `schedule_tick_rejected` (by reason: `bad_token`, `unset` or `option_disabled`, the last with the option), `schedule_option_rejected` (by option and action: create or update), `api_error` (by code, `cli_version` and, for `cli_outdated`, the request `path`), `install_sh_served`, `install_sh_missing`, `login_requested`, `signed_up`, `logged_in`, `inbox_created`, `migrations_applied` (with the count), `migrations_failed`; CLI `cli_command`, `schedule_updated` (by how: flags, file or interactive), `schedule_update_failed`, `inbox_update_rejected` (by source and reason), `cli_error`, `cli_update` (by outcome), `cli_self_update` (by outcome), `cli_outdated_seen` (by `where`: `command`, `bots_run` or `mcp`, and `reason`), `bot_session_stopped` (by how it stopped), `plan_usage_reported` (by outcome: `sent`, `failed` or `unsupported_protocol`; only when `OTEL_EXPORTER_OTLP_*` is set). The CLI identifies the logged-in user (from its session token), or a random id in `~/.loopway/install-id` before login.

Tables live in a `loopway` schema (not `public`) with RLS enabled and no policies, so a Data API (Neon's is opt-in) can't reach them.

### Login email (Resend) on the one-click deploy

Resend is a Vercel Marketplace integration (`vc i resend`; it sets `RESEND_API_KEY` and nothing else, not `EMAIL_FROM`). It is not something the clone button's `stores` parameter can add the way it adds Neon: that parameter is documented for storage products, Resend's `productSlug`/`protocol` aren't published, and the integration needs a domain bought through Vercel. So the button prompts for the two values instead (`env=RESEND_API_KEY,EMAIL_FROM`):

| Env | `envDescription` | `envLink` |
| --- | --- | --- |
| `RESEND_API_KEY` | An API key with sending access, from Resend → API Keys. | `https://resend.com/api-keys` |
| `EMAIL_FROM` | Sender of the login code, like `loopway <login@your-domain.com>`. Required when the key is set; its domain must be verified in Resend. | `https://resend.com/domains` |

A deployer who already uses the Marketplace integration can skip the key prompt: it sets `RESEND_API_KEY` under the same name, and only `EMAIL_FROM` is left to set.

**Verifying a sender domain:** in Resend → Domains, add the domain (or a subdomain such as `mail.your-domain.com`), add the SPF (`TXT`) and DKIM (`TXT`/`CNAME`) records it lists at your DNS host, and wait until the domain shows *Verified*. The address in `EMAIL_FROM` must be on that domain. Until then Resend rejects sends (recorded as `login_email_failed`), and without a verified domain Resend only delivers from `onboarding@resend.dev` to the account owner's own address.

## Releasing the CLI

The CLI is released on its own, separately from the web deploy, and nobody has to cut releases by hand. When CI passes on a push to main, `.github/workflows/release-cli.yml` checks whether anything the CLI ships has changed since the last `cli-v*` tag: `packages/cli` or a `@loopway/*` package listed in its `dependencies`, not counting their `test/` folders and markdown. If something has, it releases the next version. A failed or skipped release is picked up by the next push, because it compares against the last tag, not the last commit.

The next version is a patch bump of the last tag (`0.3.0` → `0.3.1`), so `packages/cli/package.json` doesn't need to change for a release. For a minor or major release, raise the version in `packages/cli/package.json` above the last tag (for example to `0.4.0`) and merge it. That version is used instead, and later patches count up from it. Between releases the version in `packages/cli/package.json` can be behind the released one; the workflow sets the real version before it builds. To retry a release, run the workflow from the Actions tab. It releases nothing when nothing has changed.

The workflow builds, packs `@loopway/cli` with `@loopway/harnesses`, `@loopway/presets`, `@loopway/rules` and `@loopway/palette` as `loopway-cli.tgz`, `loopway-harnesses.tgz`, `loopway-presets.tgz`, `loopway-rules.tgz` and `loopway-palette.tgz`, checks that they install and run, and publishes them as a GitHub release. Nothing goes to npm.

People install with `curl -fsSL https://loopway.craftmill.dev/install.sh | sh` (`packages/web/content/install.sh`), which installs the latest release with `npm install -g`; `LOOPWAY_VERSION=0.3.0` picks another. The script installs the tarballs listed in the release's `manifest.txt` (made by `release-cli.yml`), so a new workspace package only needs adding to the pack step there; releases without a manifest (before 0.3.0) can't be installed this way. It needs Node 22+.

A CLI installed this way updates itself (`src/update.ts`). Before every command it looks up the newest `cli-v*` release (at most once every ten minutes, cached in `~/.loopway/update-check.json`; a failed or slow lookup never blocks the command), downloads `loopway-cli.tgz`, reads its `@loopway/*` dependencies and downloads each as `loopway-<name>.tgz` too (so the update never lists packages itself), `npm install -g`s them together, then runs the command again on the new version. `loopway bots run` checks on every poll too: on finding a newer release it stops taking on work, lets the running sessions finish, releases its lease, updates and starts again. A `426 cli_outdated` from the server forces a check at once, and `loopway update` (`--force` to reinstall the newest release) installs now, skipping the cache and the auto-update setting. A failed install keeps the current version and warns. It's on by default; `loopway config update --auto-update off` (`auto_update: false` in `config.json`) or `LOOPWAY_NO_UPDATE=1` turns it off. A CLI run from a git checkout (anything not under a `node_modules` directory) never updates itself.

The CLI sends its version in an `x-loopway-cli-version` header on every request. The server labels `api_error` events with it as `cli_version` (`none` for requests without it, `unknown` for one that isn't a version), and the CLI's own events carry `cli_version` too. The oldest CLI the server accepts is `MIN_CLI_VERSION_FLOOR` in `packages/web/src/cli-version.ts`: older CLIs get `426 cli_outdated`, whose message says how to update, and the CLI updates itself and runs the command again. Self-hosted deploys can set `MIN_CLI_VERSION` (for example `0.4.0`) to go higher; it can never lower the floor in code. CLIs built before the header existed send none, so the minimum never turns them away; it only applies to releases that send their version. The web app deploys on merge, so a PR that makes the server reject something the current CLI release sends must raise `MIN_CLI_VERSION_FLOOR`, in the same PR, to the release that includes the matching CLI change (the CLI releases on merge, so that is the next patch version).

## Web UI

The same Hono app serves a small web UI: `/` (how to use loopway), `/login` (same email-code flow as the CLI; the session token is kept in `localStorage`), `/<org>` (the overview), `/<org>/bots` (the org's bots), `/<org>/bots/new` (the new-bot form), `/<org>/inboxes` (your inboxes with a create form; where source requests are on, the form's Source list ends with "Something else…", which asks for a new source type instead), `/<org>/runners` and `/<org>/members` (your runners and the org's members), `/<org>/inboxes/<inbox>` (messages with their `seq`, newest first, expandable JSON, a marker where each bot reading the inbox has read up to, and, for sources whose sender makes the secret, like Vercel, Linear, Granola and Resend, a form to paste it; the old `/dashboard/inboxes/<inbox>` and `/dashboard/<inbox>` redirect there), `/<org>/bots/<bot>` (inboxes, cursor and lease holder; rename, change inboxes or delete the bot; its threads with owner and message counts, and a Release button for threads whose runner is offline) and `/<org>/bots/<bot>/threads/<thread>` (subjects, flags, owner, and the waiting, inflight and delivered messages). Each org has its own address, `/<org-slug>`, and its pages show only that org's bots, runners and inboxes (the list endpoints take `?org=<slug>` for this; a slug you aren't a member of is a `404`, as is the page). The header's org switcher moves between your orgs and the last one you used is remembered in the browser. `/dashboard/...` still works: it redirects to the same page under the org that owns the bot or inbox it names, else your last-used org. The dashboard only reads threads and runners; transcripts stay on the runner. `GET /api` is a bare health check, and every JSON route lives under `/api`.

The pages are a React app in `packages/web/client/`. The homepage copy is markdown in [`packages/web/content/home.md`](../packages/web/content/home.md). `/llms.txt` (for tools like Codex and Claude Code) is served from [`packages/web/content/llms.txt`](../packages/web/content/llms.txt); keep it in step with the CLI. `npm run build -w @loopway/web` bundles the app with esbuild into `packages/web/public/` (git-ignored); `npm run dev` rebuilds it on change and serves it.

## Layout

```
packages/sources/
  src/                  one file per source (github.ts, linear.ts, ...): its webhook adapter, a function of the
                        SourceDeps (ids, secrets, CloudEvent validation) the host injects, and optionally its rule helpers;
                        index.ts registers them (createSources)
packages/web/
  src/sources.ts        the sources, wired to the server's real SourceDeps
  src/cloudevents.ts    CloudEvent validation
  src/index.ts          Vercel entry (default-exports the Hono app)
  src/api.ts            routes, auth, serialization
  src/ui.ts             the HTML shell, the bundle, /llms.txt and /install.sh
  client/               the React UI (pages, components, styles)
  content/              home.md, llms.txt, install.sh
  ee/                   enterprise-licensed routes and client code (source and harness requests)
  src/store.ts          all SQL
  src/db/               postgres.js adapter + migrations; run-migrations.ts runs them (the Vercel build); testing.ts opens a
                        throwaway test database
  scripts/              dev.ts (dev server), build.ts (migrate, then bundle), client.ts (the esbuild bundle), env.ts, migrate.ts
  test/api.test.ts      end-to-end tests (TEST_DATABASE_URL points at a different Postgres server)
  test/sources/         one webhook test file per source
packages/cli/
  src/index.ts          `loopway` entry: error handling + exit codes
  src/program.ts        commands and flags (commander)
  src/commands/         auth, orgs, inboxes (incl. the create TUI, @clack/prompts), messages, bots, botThreads, runners, bots-run (`loopway bots run`)
  src/client.ts         typed API client
  src/config.ts         ~/.loopway/config.json
  src/mcp.ts            minimal MCP server (HTTP, localhost) the bots dispatcher serves to its sessions
  src/bots/             `loopway bots run`: dispatcher.ts (runner lease, work feed, claim, deliver), runner.ts (runs the sessions),
                        workdirs.ts (the loopway.json working directories), github.ts, tools.ts (MCP link/end),
                        tui.tsx (the Ink TUI), colors.ts, transcript.ts (stream-json log → readable lines)
  test/cli.test.ts      runs commands against the real API app in-process
  test/tui.test.tsx     renders the threads TUI with ink-testing-library
packages/harnesses/
  src/                  one file per harness a bot can run on (claude.ts, codex.ts, cursor.ts, hermes.ts, script.ts); index.ts lists them
packages/rules/
  src/index.ts          CEL assign rules: message → thread, with the sources' rule helpers
packages/presets/
  src/                  bot presets: github-threads has its prompt and starting rules
packages/palette/
  src/index.ts          the brand colors, each in its paper (light) and ink (dark) tone
packages/bb-plugin-loopway/
                        `loopway bots run` as a bb plugin: server.ts, the Loopway page (app.tsx), status.ts
```

### Adding a source

1. Add `packages/sources/src/<type>.ts` exporting a function from `SourceDeps` to a `SourceAdapter` (`types.ts`); use the injected `newSecret`, `uuidv7`, `safeEqual` and `makeCloudEvent` rather than importing your own:
   - what clients show: `label`, `description`, common `events`, `secret` (`{from: "loopway", minLength}` if loopway makes it, `{from: "sender"}` if the sender shows one after the webhook is added) and `webhookSettings`
   - optional `rules`: the CEL helpers (`<type>_<helper>`) bot rules can call on its event types
   - `parseConfig` (validate + defaults), `publicConfig`, optional `setup`, and `receive(headers, rawBody) → event | ignored | rejected`
2. Add it to `createSources` in `packages/sources/src/index.ts`.
3. Add `packages/web/test/sources/<type>.test.ts` (`test/helpers.ts` gives it an app and database) and write `docs/sources/<type>.md` (config, setup in the sender, delivery rules, CloudEvent mapping) like the [existing ones](sources/).

Nothing else names a source: the API, `loopway inbox create` and the dashboard build their forms from `GET /sources`, and the inbox page offers a secret form for any `sender` source.
