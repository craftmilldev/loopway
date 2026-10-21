# loopway

loopway is a place to build bots and work alongside them. It accepts webhooks from the services you already use (GitHub, Vercel, Linear, Granola and Resend, plus loopway itself so bots can message each other, and a schedule inbox that fills on a clock), stores each delivery as a [CloudEvent](https://github.com/cloudevents/spec) in an **inbox**, and lets a bot work through them one at a time. The bot can be a script, a cron job or a Claude agent.

- An **inbox** belongs to a user and listens to one source. The source's webhook points at the inbox, which checks the signature and keeps the message.
- A **message** is a stored delivery: the CloudEvent, when it arrived, and its place in arrival order. Nothing is marked done.
- A **bot** reads the messages of one or more inboxes in arrival order and keeps a cursor, so it knows where it left off. `loopway bots run` hands an inbox's messages to agent sessions in the bot's harness (Claude Code, Codex, Cursor, Hermes, or a script), one session per thread as the bot's rules group them, and a session picks up new messages for its thread as they come in.

It runs on Vercel at [loopway.craftmill.dev](https://loopway.craftmill.dev), with a small web UI for logging in, creating inboxes and bots, and seeing runners, threads and messages. To run your own copy, press the button (what it asks for is in [developing.md](docs/developing.md#deploy-with-the-vercel-button); pointing the CLI at it and [updating it](docs/developing.md#updating-a-self-hosted-deploy) are covered there too):

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcraftmilldev%2Floopway&root-directory=packages%2Fweb&project-name=loopway&repository-name=loopway&env=TOKEN_SECRET%2CCRON_SECRET%2CINBOX_SECRET_KEY%2CSELF_HOSTED%2CRESEND_API_KEY%2CEMAIL_FROM&envDescription=Generate%20TOKEN_SECRET%20and%20CRON_SECRET%20with%20openssl%20rand%20-hex%2032%2C%20INBOX_SECRET_KEY%20with%20openssl%20rand%20-base64%2032%20%28keep%20a%20copy%29%3B%20SELF_HOSTED%3D1%3B%20RESEND_API_KEY%20and%20EMAIL_FROM%20for%20login%20emails&envLink=https%3A%2F%2Fgithub.com%2Fcraftmilldev%2Floopway%2Fblob%2Fmain%2Fdocs%2Fdeveloping.md%23deploy-with-the-vercel-button&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

- [`docs/sources/`](docs/sources/): one page per source ([github](docs/sources/github.md), [vercel](docs/sources/vercel.md), [linear](docs/sources/linear.md), [granola](docs/sources/granola.md), [resend](docs/sources/resend.md), [loopway](docs/sources/loopway.md), [schedule](docs/sources/schedule.md)): its config, how to connect it, and how its deliveries map to CloudEvents.
- [`docs/api.md`](docs/api.md): the HTTP API and the webhook ingestion rules.
- [`docs/developing.md`](docs/developing.md): running the server locally, deploying it, the repo layout, and adding a source.

## Getting started

```bash
curl -fsSL https://loopway.craftmill.dev/install.sh | sh   # puts `loopway` on your PATH; needs Node 22+
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
loopway bots threads end <bot> <thread>             # end a thread; its next message resumes it
loopway runners                                     # the machines running your bots, their orgs, and what each holds
loopway bots run [--max 3] [--interval 5] [--ttl <seconds>] [--no-tui]   # run your bots (see below)
```

- `<inbox>` is an inbox id or its exact name; `<bot>` is a bot id or its exact name.
- Every read command takes `--json` for the raw API response.
- `inbox create` and `bots create` take `--org <slug>`. Without it, your only org is used; with several, a terminal asks and a script fails listing the slugs. `inbox create` skips any prompt whose flag is given (`--name`, `--source`, `--events push,pull_request`, `--secret`, `--schema file.json` for `loopway` inboxes); without a terminal it runs from flags alone. For sources whose sender makes the secret (`vercel`, `granola`, `resend`) it doesn't ask for one: add the webhook in the sender, then paste the secret it shows with `loopway inbox update <inbox>` (or on the inbox's dashboard page).
- Credentials live in `~/.loopway/config.json` (`{ "api_url", "api_key" }`, plus an optional `github` bot for [bot sessions](#acting-as-a-github-bot), mode 0600). `LOOPWAY_API_URL` / `LOOPWAY_API_KEY` override it, e.g. in CI. The URL defaults to `https://loopway.craftmill.dev`.
- New CLI features ship behind opt-in flags. The manager bot is off until you run `loopway config update --manager` (`--no-manager` turns it off). `--manager-harness <name>` (default `claude`; an unknown name is rejected with the valid ones) and `--manager-model <name>` set what it runs on. They're saved as `"manager": { "enabled", "harness", "model" }` in `config.json`; `LOOPWAY_MANAGER=1`/`0`, `LOOPWAY_MANAGER_HARNESS` and `LOOPWAY_MANAGER_MODEL` override it, `loopway config` shows the result, and `loopway login` keeps the block. They configure the manager in Chat (see [Running bots](#running-bots)); a model left out is the harness's own.
- A bot reads messages from one or more inboxes (see [Bots](docs/api.md#bots)). `--preset` picks the template its first prompt and rules are copied from; the bot doesn't remember it. `loopway bots run` runs them (see [Running bots](#running-bots)).

### Running bots

```bash
loopway bots run [--max 3] [--interval 5] [--ttl <seconds>] [--no-tui]   # run your bots (q or Ctrl-C to stop)
```

`loopway bots run` runs every bot on your account that has a prompt and rules, in the current directory or the directory `loopway.json` gives it (see **Working directories** below). With no bots, it says how to create one and exits (with the manager on, it opens in the Chat view below instead). One process runs all your bots, and `--max` is shared across them, since it caps the load on this machine.

**Org.** A runner belongs to one org and only runs that org's bots. `loopway bots run --org <slug>` picks it; without the flag your only org is used, or you're asked to choose between several (non-interactively it fails and lists the slugs). The choice is saved with the runner in `~/.loopway/runner.json`, so later runs in that directory don't ask. A runner never moves: `--org` with another org starts a new runner for it. A `runner.json` from before orgs has no org saved yet; if its runner belongs to a different org than the one chosen, `bots run` says which, and that deleting `runner.json` starts a new runner.

In a terminal, `loopway bots run` takes over the screen. The header names the bots this runner holds, and any it skipped because another runner holds their lease. Below are four lists: waiting messages (assigned to one of this runner's threads but not delivered yet), working threads (a run in flight), waiting threads (active, waiting for their next message) and done threads (ended, newest first). Threads owned by another runner are listed too, marked "on <runner>"; their sessions live on that machine, so this runner leaves them alone. ↑/↓ moves between sessions, Tab/Shift-Tab jumps between lists, and Enter or → opens a session's transcript, which follows new output until you scroll up (↑/↓, PgUp/PgDn, Home/End). ← goes back to the lists. The dispatcher's latest log line shows at the bottom. Quitting stops the dispatcher and its sessions, as Ctrl-C does. `--no-tui`, or output that isn't a terminal, prints the plain log instead.

**Chat.** With the opt-in manager on (`loopway config --manager`, or `LOOPWAY_MANAGER=1`), the lists get a second view: `c` opens Chat, a transcript with a one-line input. Type, and Enter sends your message to the manager, the org's built-in bot (id `manager:<org slug>`; it has no row in the bots database and runs in the same process as your bots). The first message starts an agent session on the harness and model from `manager.harness` / `manager.model`; later messages resume it, so it remembers the conversation. The reply streams into the transcript (its words, and the `loopway` commands it ran), with "thinking…" shown while a run is in flight; a message sent meanwhile is ignored. A failed run (the harness not installed, an API error, the usage limit) shows as an error line in the chat and the next message tries again. The transcript is kept in `~/.loopway/chats/<chat>.log`, one chat per `bots run`; nothing is recorded on the server. ↑/↓, PgUp/PgDn and Home/End scroll it. ← (or Esc) goes back to the lists, which show `c chat` in their footer, and the chat is still there when you return. Ctrl-C quits from Chat. With no bots and the manager on, `bots run` opens in Chat and keeps running until you quit. With the manager off, none of this shows.

**The manager is read-only.** Its prompt ([`manager-prompt.ts`](packages/presets/src/manager-prompt.ts)) has it answer questions about bots, inboxes, threads, runners and recent messages by running `loopway bots list/show/versions/threads/messages`, `loopway runners`, `loopway messages list` and `loopway inbox list/show`, and say plainly that it can't create, change or delete anything yet. On Claude Code that is enforced, not just asked: the session gets only those commands as tools (everything else is denied, not approved), `loopway bots threads release` and `end`, file edits, file reads (`Read`, `Grep`, `Glob`, `cat` and the like) and web tools are denied outright, and it has no MCP tools. The other harnesses have no such switch, so there the limit is the prompt alone, and the chat says so with a warning line on the first message; use `claude` for the manager if that matters. The manager runs `loopway` from the runner's environment, so it sees what you see.

**Leasing.** At startup, and every tick, the runner takes or renews each bot's lease (`POST /api/bots/:id/lease`, held for `--ttl` seconds: by default six polls, at least 30 s). A bot leased by another runner is skipped, with one log line saying until when, and tried again next tick, so two copies of `loopway bots run` never read the same bot. It also leases this machine's runner (`POST /runners/:id/lease`, same TTL), so a second `loopway bots run` on the machine, or a copy of `~/.loopway/runner.json`, stops with a message instead of sharing it. Quitting, `kill`, a closed terminal and a crash all release the leases on the way out; a runner killed outright (SIGKILL, power loss) leaves its leases to expire within `--ttl`, or `loopway bots release <bot> --force` drops one right away.

**Each tick, per leased bot**, every `--interval` seconds:

1. It reads `GET /api/bots/:id/messages` until there are none.
2. It loads the bot's threads (`GET /api/bots/:id/threads?status=all`) and routes each message to one. It collects the message's subjects, its own issue/PR plus the issues a PR body closes (`Closes #N`). The thread holding the message's own subject wins; otherwise the first closed issue, in body order, that a thread holds; otherwise it's a new thread. The message's subjects that no thread holds are added to the thread, and ones another thread holds stay there. Messages for an issue labeled `future` that has no thread yet are dropped, so ideas can be recorded without being worked on. Routing never waits on `--max` or on a running session; an assigned message waits on its thread until it can be delivered.
3. The routes go to the server in one `POST /api/bots/:id/assign` (with the bot's lease), which creates the new threads, adds the subjects, records the messages as waiting and moves the cursor past them, all or nothing. This runner then claims the threads it created (`POST /api/bots/:id/threads/:id/claim`).
4. Every thread of this runner with waiting messages and no run in flight gets them all in one run (`claude -p --permission-mode auto`, then `claude --resume`), oldest first, while `--max` allows. `--max` caps runs in flight, not sessions: a session waiting for its next message doesn't count, so any number can wait.

**Working directories.** A `loopway.json` in the directory `loopway bots run` starts in can give bots their own working directory: `{"bots": {"<bot name>": {"cwd": "path/relative/to/here"}}}`. That bot's sessions then start in that directory, with the runner's directory added as an extra working directory (`--add-dir` for Claude Code and Cursor; Codex runs unsandboxed, so it only gets the directory itself, as `-C` on a new thread), so a runner started from a workspace of several repos can run each bot in its repo while the session can still read the whole workspace. A bot the file doesn't name, or whose `cwd` is `.`, runs in the runner's directory as before. A `cwd` that isn't a directory stops `bots run` at startup. Claude Code finds a session by the directory it ran in, so changing a bot's `cwd` orphans its open sessions: they can't be resumed from the new one.

**Scripts.** `--harness script` runs a shell command instead of a coding agent, for bots that call an API and act on the answer themselves. The command is the bot's prompt, so it is edited and versioned like one. It runs through `sh -c` in the bot's directory with the thread's messages on stdin and `LOOPWAY_SESSION_ID` and `LOOPWAY_MCP_URL` in its environment; read the messages with `loopway messages get`. Exit 0 ends the thread, exit 255 (-1) leaves it waiting for its next messages, and any other code is a failed run. A failed run does not redeliver its messages (only a usage limit or API error does), so retry inside the script, or exit 255, if a transient failure (say a timed-out call) should be tried again. Create one with `loopway bots create --harness script --name <name> --inbox <inbox>` (no `--model` or `--preset`), then save the command with `loopway bots edit <bot> --prompt-file <file>`; the model is stored as `see-script`. Because the command is the prompt, anyone who can save a prompt version for the bot (any member of its org, or anyone holding an API key) can run shell commands as the user running `loopway bots run`; the other harnesses run unsandboxed with the same access, so this is the same trust boundary. A bot can't be switched to or from the script harness.

**Codex.** `--harness codex` runs a bot with the OpenAI Codex CLI (`codex exec`), signed in the way your own `codex` is (`codex login`); `--model` is one of the models `codex` lists (see `CodexHarness.models`).

**Usage limits.** When a run stops because the account hit its Claude usage limit (Claude Code reports a rejected `rate_limit_event` with the reset time, then a `result` with `api_error: usage_limit_reached`), the runner delivers nothing to any session until the limit resets, then carries on from its next tick. Messages keep being read and assigned meanwhile. Messages go in as stream-json with `--replay-user-messages`, so the runner sees when Claude Code has taken a message into the session: if the stopped run had taken its messages, the session is resumed with a note to carry on; if not, they go back to waiting and are delivered again. Without a reset time it waits 5 minutes. The hold itself lives in the runner process: a restarted runner retries right away and learns the reset time again if the limit still holds.

A thread is an issue and the PRs linked to it, whose subjects are `owner/repo#number`. Threads live on the server and belong to the runner that claimed them, so `loopway bots threads <bot>` shows what's running, and a runner only delivers to and writes its own (with its runner lease token; see [Threads](docs/api.md#threads)). A thread whose machine is gone stays where it is until `loopway bots threads release` frees it. A new session starts with the bot's prompt, stored in the database with its assign rules as a bot version. Presets live in `packages/presets/src`, a map from name to the prompt and rules a new bot starts with; the default `github-threads` one is [`github-threads-prompt.ts`](packages/presets/src/github-threads-prompt.ts) and [`github-threads-rules.ts`](packages/presets/src/github-threads-rules.ts).

Sessions talk back to the dispatcher over MCP: it serves a `loopway` server on 127.0.0.1 (one URL per session, passed with `--mcp-config`) with two tools:

- `link` adds a subject to the session's thread (`PATCH` with `add_subjects`): any string the bot's rules produce, such as `owner/repo#9` or `linear/CRA-41`, or a `number` (and `repo`) for `owner/repo#number`. Sessions call it right after opening a PR; a PR whose body says `Closes #N` also joins issue N's thread on its own.
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
