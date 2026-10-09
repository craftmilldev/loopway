# loopway

loopway is a place to build bots and work alongside them. It accepts webhooks from the services you already use (GitHub, Vercel and Granola so far, plus loopway itself so bots can message each other), stores each delivery as a [CloudEvent](https://github.com/cloudevents/spec) in an **inbox**, and lets a bot work through them one at a time. The bot can be a script, a cron job or a Claude agent.

- An **inbox** belongs to a user and listens to one source. The source's webhook points at the inbox, which checks the signature and keeps the event.
- An **event** is a stored message: the CloudEvent, when it arrived, and its place in arrival order. Nothing is marked done.
- A **bot** reads the events of one or more inboxes in arrival order and keeps a cursor, so it knows where it left off. `loopway bots run` turns GitHub issues and PRs into Claude Code sessions that pick up comments and reviews as they come in.

It runs on Vercel at [loopway.craftmill.dev](https://loopway.craftmill.dev), with a small web UI for logging in, creating inboxes and reading events.

- [`docs/sources/`](docs/sources/): one page per source ([github](docs/sources/github.md), [vercel](docs/sources/vercel.md), [granola](docs/sources/granola.md), [loopway](docs/sources/loopway.md)): its config, how to connect it, and how its deliveries map to CloudEvents.
- [`docs/api.md`](docs/api.md): the HTTP API and the webhook ingestion rules.
- [`docs/developing.md`](docs/developing.md): running the server locally, deploying it, the repo layout, and adding a source.

## Getting started

```bash
npm install && npm run build -w @loopway/cli && npm link -w @loopway/cli   # puts `loopway` on your PATH
loopway login                 # emails you a one-time code; new emails get an account
loopway inbox create          # name → source → events → secret → confirm
loopway inbox show <inbox>    # the webhook URL and secret to add in the sender
loopway events list <inbox>
```

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
loopway inbox show <inbox>             # webhook setup + event count
loopway inbox update <inbox> [--name n] [--events a,b] [--secret s] [--schema file.json]   # with no flags in a terminal, asks for the secret

loopway events list <inbox> [--type 'com.github.pull_request.*'] [--limit 20] [--all]
loopway events get  <inbox> <event> [--data]

loopway bots create --name dev --kind github-threads --model sonnet --inbox <inbox>[,<inbox>]
loopway bots list
loopway bots show <bot>
loopway bots update <bot> [--name n] [--model m] [--inbox a,b]   # --inbox replaces the bot's inboxes
loopway bots delete <bot>
loopway bots messages <bot> [--limit 20]            # what the bot would read next
loopway bots run [--max 3] [--interval 5] [--ttl 3600] [--no-tui]   # run your bots (see below)
```

- `<inbox>` is an inbox id or its exact name; `<bot>` is a bot id or its exact name.
- Every read command takes `--json` for the raw API response.
- `inbox create` skips any prompt whose flag is given (`--name`, `--source`, `--events push,pull_request`, `--secret`, `--schema file.json` for `loopway` inboxes); without a terminal it runs from flags alone. For sources whose sender makes the secret (`vercel`, `granola`) it doesn't ask for one: add the webhook in the sender, then paste the secret it shows with `loopway inbox update <inbox>` (or on the inbox's dashboard page).
- Credentials live in `~/.loopway/config.json` (`{ "api_url", "api_key" }`, plus an optional `github` bot for [bot sessions](#acting-as-a-github-bot), mode 0600). `LOOPWAY_API_URL` / `LOOPWAY_API_KEY` override it, e.g. in CI. The URL defaults to `https://loopway.craftmill.dev`.
- A bot reads messages from one or more inboxes (see [Bots](docs/api.md#bots)). `--kind` must be one this CLI knows how to run: `github-threads`. `loopway bots run` runs them (see [Running bots](#running-bots)).

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

**Usage limits.** When a run stops because the account hit its Claude usage limit (Claude Code reports a rejected `rate_limit_event` with the reset time, then a `result` with `api_error: usage_limit_reached`), the runner delivers nothing to any session until the limit resets, then carries on from its next tick. Messages keep being read and assigned meanwhile. Messages go in as stream-json with `--replay-user-messages`, so the runner sees when Claude Code has taken a message into the session: if the stopped run had taken its messages, the session is resumed with a note to carry on; if not, they go back to waiting and are delivered again. Without a reset time it waits 5 minutes. The hold itself lives in the runner process: a restarted runner retries right away and learns the reset time again if the limit still holds.

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

