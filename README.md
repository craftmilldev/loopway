# loopway

loopway is a place to build bots and work alongside them. It accepts webhooks from the services you already use (GitHub, Vercel and Granola so far, plus loopway itself so bots can message each other), stores each delivery as a [CloudEvent](https://github.com/cloudevents/spec) in an **inbox**, and lets a bot work through them one at a time. The bot can be a script, a cron job or a Claude agent.

- An **inbox** belongs to a user and listens to one source. The source's webhook points at the inbox, which checks the signature and keeps the message.
- A **message** is a stored delivery: the CloudEvent, when it arrived, and its place in arrival order. Nothing is marked done.
- A **bot** reads the messages of one or more inboxes in arrival order and keeps a cursor, so it knows where it left off. `loopway bots run` turns GitHub issues and PRs into Claude Code sessions that pick up comments and reviews as they come in.

It runs on Vercel at [loopway.craftmill.dev](https://loopway.craftmill.dev), with a small web UI for logging in, creating inboxes and bots, and seeing runners, threads and messages.

- [`docs/sources/`](docs/sources/): one page per source ([github](docs/sources/github.md), [vercel](docs/sources/vercel.md), [granola](docs/sources/granola.md), [resend](docs/sources/resend.md), [loopway](docs/sources/loopway.md)): its config, how to connect it, and how its deliveries map to CloudEvents.
- [`docs/api.md`](docs/api.md): the HTTP API and the webhook ingestion rules.
- [`docs/developing.md`](docs/developing.md): running the server locally, deploying it, the repo layout, and adding a source.

## Getting started

```bash
curl -fsSL https://loopway.craftmill.dev/install.sh | sh   # puts `loopway` on your PATH; needs Node 22.21+
loopway login                 # emails you a one-time code; new emails get an account
loopway inbox create          # name → source → events → secret → confirm
loopway inbox show <inbox>    # the webhook URL and secret to add in the sender
loopway messages list <inbox>
```

## CLI

`loopway` lives in `packages/cli` and talks to the API over HTTP.

```bash
npm run cli -- <command>                                       # from the repo, no build
npm run build -w @loopway/cli && npm link -w @loopway/cli      # or put your checkout's build on your PATH
```

```bash
loopway config update                  # sets the API URL (default https://loopway.craftmill.dev) and, optionally, a GitHub bot; skip it for the defaults
loopway login                          # emails you a one-time code, trades it for a 30-day session token, saves it (new emails get an account)
loopway whoami
loopway clear-config                   # deletes ~/.loopway/config.json

loopway orgs                           # your orgs
loopway orgs members <slug>            # members and pending emails
loopway orgs create <slug> [--name <name>] # a shared org, with you as its only member
loopway orgs add-member <slug> <email> # no account yet? they join the first time they log in
loopway orgs remove-member <slug> <username-or-email>
loopway orgs leave <slug>              # an org's last member can't leave

loopway inbox create                   # interactive: name → source → events → secret → confirm
loopway inbox list
loopway inbox show <inbox>             # webhook setup + message count
loopway inbox update <inbox> [--name n] [--events a,b] [--secret s] [--schema file.json]   # with no flags in a terminal, asks for the secret
loopway inbox update <schedule-inbox> [--every hour|day] [--hour 0-23] [--message type=text] [--message-file type=path] [--remove-message type] [--config file.json]   # see docs/sources/schedule.md

loopway messages list <inbox> [--type 'com.github.pull_request.*'] [--limit 20] [--all]
loopway messages get  <inbox> <message> [--data]

loopway bots create --name dev --preset github-threads --model sonnet --inbox <inbox>[,<inbox>]
loopway bots list
loopway bots show <bot>
loopway bots update <bot> [--name n] [--model m] [--inbox a,b]   # --inbox replaces the bot's inboxes
loopway bots delete <bot>
loopway bots messages <bot> [--limit 20]            # what the bot would read next
loopway bots release <bot> --force                  # drop a lease a dead runner left behind
loopway bots threads <bot> [--status active|ended|all]   # the threads the server has for the bot
loopway bots threads release <bot> <thread>         # give up a thread whose runner is gone, so another can claim it
loopway runners                                     # the machines running your bots, their orgs, and what each holds
loopway bots run [--max 3] [--interval 5] [--ttl <seconds>] [--no-tui]   # run your bots (see below)
```

- `<inbox>` is an inbox id or its exact name; `<bot>` is a bot id or its exact name.
- Every read command takes `--json` for the raw API response.
- `inbox create` and `bots create` take `--org <slug>`. Without it, your only org is used; with several, a terminal asks and a script fails listing the slugs. `inbox create` skips any prompt whose flag is given (`--name`, `--source`, `--events push,pull_request`, `--secret`, `--schema file.json` for `loopway` inboxes); without a terminal it runs from flags alone. For sources whose sender makes the secret (`vercel`, `granola`, `resend`) it doesn't ask for one: add the webhook in the sender, then paste the secret it shows with `loopway inbox update <inbox>` (or on the inbox's dashboard page).
- Credentials live in `~/.loopway/config.json` (`{ "api_url", "api_key" }`, plus an optional `github` bot for [bot sessions](#acting-as-a-github-bot), mode 0600). `LOOPWAY_API_URL` / `LOOPWAY_API_KEY` override it, e.g. in CI. The URL defaults to `https://loopway.craftmill.dev`.
- A bot reads messages from one or more inboxes (see [Bots](docs/api.md#bots)). `--preset` picks the template its first prompt and rules are copied from; the bot doesn't remember it. `loopway bots run` runs them (see [Running bots](#running-bots)).

### Running bots

```bash
loopway bots run [--max 3] [--interval 5] [--ttl <seconds>] [--no-tui]   # run your bots (q or Ctrl-C to stop)
```

`loopway bots run` runs every bot on your account that has a prompt and rules, in the current directory. With no bots, it says how to create one and exits. One process runs all your bots, and `--max` is shared across them, since it caps the load on this machine.

**Org.** A runner belongs to one org and only runs that org's bots. `loopway bots run --org <slug>` picks it; without the flag your only org is used, or you're asked to choose between several (non-interactively it fails and lists the slugs). The choice is saved with the runner in `~/.loopway/runner.json`, so later runs in that directory don't ask. A runner never moves: `--org` with another org starts a new runner for it. A `runner.json` from before orgs has no org saved yet; if its runner belongs to a different org than the one chosen, `bots run` says which, and that deleting `runner.json` starts a new runner.

In a terminal, `loopway bots run` takes over the screen. The header names the bots this runner holds, and any it skipped because another runner holds their lease. Below are four lists: waiting messages (assigned to one of this runner's threads but not delivered yet), working threads (a run in flight), waiting threads (active, waiting for their next message) and done threads (ended, newest first). Threads owned by another runner are listed too, marked "on <runner>"; their sessions live on that machine, so this runner leaves them alone. ↑/↓ moves between sessions, Tab/Shift-Tab jumps between lists, and Enter or → opens a session's transcript, which follows new output until you scroll up (↑/↓, PgUp/PgDn, Home/End). ← goes back to the lists. The dispatcher's latest log line shows at the bottom. Quitting stops the dispatcher and its sessions, as Ctrl-C does. `--no-tui`, or output that isn't a terminal, prints the plain log instead.

**Leasing.** At startup, and every tick, the runner takes or renews each bot's lease (`POST /api/bots/:id/lease`, held for `--ttl` seconds: by default six polls, at least 30 s). A bot leased by another runner is skipped, with one log line saying until when, and tried again next tick, so two copies of `loopway bots run` never read the same bot. It also leases this machine's runner (`POST /runners/:id/lease`, same TTL), so a second `loopway bots run` on the machine, or a copy of `~/.loopway/runner.json`, stops with a message instead of sharing it. Quitting, `kill`, a closed terminal and a crash all release the leases on the way out; a runner killed outright (SIGKILL, power loss) leaves its leases to expire within `--ttl`, or `loopway bots release <bot> --force` drops one right away.

**Each tick, per leased bot**, every `--interval` seconds:

1. It reads `GET /api/bots/:id/messages` until there are none.
2. It loads the bot's threads (`GET /api/bots/:id/threads?status=all`) and routes each message to one. It collects the message's subjects, its own issue/PR plus the issues a PR body closes (`Closes #N`). The thread holding the message's own subject wins; otherwise the first closed issue, in body order, that a thread holds; otherwise it's a new thread. The message's subjects that no thread holds are added to the thread, and ones another thread holds stay there. Messages for an issue labeled `future` that has no thread yet are dropped, so ideas can be recorded without being worked on. Routing never waits on `--max` or on a running session; an assigned message waits on its thread until it can be delivered.
3. The routes go to the server in one `POST /api/bots/:id/assign` (with the bot's lease), which creates the new threads, adds the subjects, records the messages as waiting and moves the cursor past them, all or nothing. This runner then claims the threads it created (`POST /api/bots/:id/threads/:id/claim`).
4. Every thread of this runner with waiting messages and no run in flight gets them all in one run (`claude -p --permission-mode auto`, then `claude --resume`), oldest first, while `--max` allows. `--max` caps runs in flight, not sessions: a session waiting for its next message doesn't count, so any number can wait.

**Sandbox.** Claude bots run inside Claude Code's sandbox by default (macOS, Linux and WSL2). It needs `bubblewrap` and `socat` on Linux/WSL2 (`sudo apt-get install bubblewrap socat`), and `loopway bots run` refuses to start without them; native Windows isn't supported, so use WSL2 or turn the sandbox off (below). Writes, from commands and from Claude's Edit/Write tools, are limited to the directory you ran `loopway bots run` in (and the git dir its worktrees share), temp, `~/.npm`, `~/.cache`, `~/.claude` and `~/.loopway`. Reads of `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh` and `~/.netrc` are denied. `~/.claude` and `~/.loopway` are writable (sessions and logs live there) except the files that change how later sessions behave or hold credentials: Claude's settings, `CLAUDE.md`, hooks, skills, commands, agents and plugins, and `~/.loopway/config.json` and `runner.json`. The network is open. Claude's sandbox only reaches the network through a proxy and won't take a wildcard for every host, so `loopway bots run` starts a local proxy (127.0.0.1) that lets every host through. Because `~/.config/gh` is unreadable (and the macOS keychain is out of reach), `gh` in a bot uses the bot's token as `GH_TOKEN` and its own config directory, `~/.loopway/gh`. The policy is in `packages/harnesses/src/sandbox.ts`.

**Codex.** `--harness codex` runs a bot with the OpenAI Codex CLI (`codex exec`), signed in the way your own `codex` is (`codex login`); `--model` is one of the models `codex` lists (see `CodexHarness.models`). Its sandbox limits writes to the same places as above (minus `~/.claude`) with the network open, but unlike Claude's it can't deny reads of `~/.ssh` and the like. `--no-sandbox` turns it off.

**Turning the sandbox off.** `loopway bots run --no-sandbox` starts bots without it for that run, and `loopway config update --sandbox off` (or `"sandbox": false` in `~/.loopway/config.json`) does so every time; `config update --sandbox on` turns it back on. The flag wins when both are set, and with neither the sandbox is on. Without the sandbox, bots can read and write anything you can, including your SSH keys and cloud credentials, and `loopway bots run` doesn't check for `bubblewrap`/`socat`, so it also works on native Windows. It prints `WARNING: the sandbox is off, so bots run with full access to your files` at startup and writes the same line to each session's log (`~/.loopway/threads/<thread>.log`) at the start of every run. Only do this on a machine and with bots you trust.

**Usage limits.** When a run stops because the account hit its Claude usage limit (Claude Code reports a rejected `rate_limit_event` with the reset time, then a `result` with `api_error: usage_limit_reached`), the runner delivers nothing to any session until the limit resets, then carries on from its next tick. Messages keep being read and assigned meanwhile. Messages go in as stream-json with `--replay-user-messages`, so the runner sees when Claude Code has taken a message into the session: if the stopped run had taken its messages, the session is resumed with a note to carry on; if not, they go back to waiting and are delivered again. Without a reset time it waits 5 minutes. The hold itself lives in the runner process: a restarted runner retries right away and learns the reset time again if the limit still holds.

A thread is an issue and the PRs linked to it, whose subjects are `owner/repo#number`. Threads live on the server and belong to the runner that claimed them, so `loopway bots threads <bot>` shows what's running, and a runner only delivers to and writes its own (with its runner lease token; see [Threads](docs/api.md#threads)). A thread whose machine is gone stays where it is until `loopway bots threads release` frees it. A new session starts with the bot's prompt, stored in the database with its assign rules as a bot version. Presets live in `packages/presets/src`, a map from name to the prompt and rules a new bot starts with; the default `github-threads` one is [`github-threads-prompt.ts`](packages/presets/src/github-threads-prompt.ts) and [`github-threads-rules.ts`](packages/presets/src/github-threads-rules.ts).

Sessions talk back to the dispatcher over MCP: it serves a `loopway` server on 127.0.0.1 (one URL per session, passed with `--mcp-config`) with two tools:

- `link` adds a PR to the session's thread (`PATCH` with `add_subjects`). Sessions call it right after opening a PR; a PR whose body says `Closes #N` also joins issue N's thread on its own.
- `end` marks the thread finished (`PATCH` with `status: "ended"`). The session decides when that is (a close event usually means it, but not always). A later message for the thread resumes it and makes it active again.

Delivery doesn't touch the inbox's messages: they aren't locked or marked processed, and a session never marks them done. They're context for the thread, and `end` is what finishes it. A delivery lists each message's id, type, subject and the command that reads it, `loopway messages get <inbox> <message> --data` (a bot can read several inboxes). Each thread's transcript (stream-json) is appended to `~/.loopway/threads/<thread>.log` on the machine whose runner owns it. A runner that dies mid-run leaves the messages it was delivering inflight; the next `loopway bots run` on that machine puts them back to waiting and delivers them again.

The inbox's GitHub webhook needs `pull_request`, `pull_request_review` and `pull_request_review_comment` (as well as `issues` and `issue_comment`) for reviews to reach sessions.

#### Acting as a GitHub bot

By default sessions use your own `gh` login and git credentials, so their comments, PRs and commits look like yours. To have them act as a bot user instead, add the bot's token and git identity. The token can be a fine-grained PAT with contents, issues and pull requests read/write on an org that allows them, or a classic PAT with `repo` scope (needed for repos where the bot is only a collaborator). Set them with `loopway config update`, which prompts for each one in a terminal (an empty answer keeps the saved value), or pass flags:

```sh
loopway config update --github-token github_pat_... --github-name loopway-bot --github-email 12345+loopway-bot@users.noreply.github.com
```

They're saved as the `github` block in `~/.loopway/config.json`:

```json
{
  "api_url": "...",
  "api_key": "...",
  "github": { "token": "github_pat_...", "name": "loopway-bot", "email": "12345+loopway-bot@users.noreply.github.com" }
}
```

`LOOPWAY_GITHUB_TOKEN`, `LOOPWAY_GITHUB_NAME` and `LOOPWAY_GITHUB_EMAIL` override it. Set all three or none; `loopway config update` won't save only some. `loopway login` keeps the `github` block. Each session then gets:

- `GH_TOKEN` and `GITHUB_TOKEN`, so `gh` comments and opens PRs as the bot, and other tools that read `GITHUB_TOKEN` don't get a token you exported;
- a git credential helper for `https://github.com` that answers with the bot's token, replacing your own helpers there, with `git@github.com:` remotes rewritten to HTTPS so pushes use it too;
- `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to the bot.

The git settings are passed as `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, so nothing is written to your git config.

## License

loopway is open core. Everything is MIT-licensed (see [`LICENSE`](LICENSE)) except the code under [`packages/web/ee`](packages/web/ee), which is under the loopway Enterprise License ([`packages/web/ee/LICENSE`](packages/web/ee/LICENSE)). Today that is source requests, the dashboard option that lets a user ask for a webhook source loopway doesn't have.
