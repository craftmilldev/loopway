# Changelog

## 2.0.0-alpha

loopway goes local. Run `loopway` in a directory with a `.loopway/` folder and it polls GitHub, printing every new issue and pull request by you or your bot and every update to the ones it knows. See [#486](https://github.com/craftmilldev/loopway/issues/486).

### Added

- Bare `loopway`, with `--json`. Bots are `.loopway/<bot>.md` files; state is JSON per project, in `~/.loopway/state/<slug>`.

- Sessions: each open thread's queued updates go to a Claude Code session that acts as the bot user and talks back through loopway's own MCP server (`comment`). `--max N` caps runs in flight. Bot files gain `model` and `harness`. Each thread has a `session`, the `sent` messages and a `<id>.log`.

- Threads that create issues and pull requests: the MCP tools `create_issue` and `create_pr` open them as the bot user with the thread's marker. The thread tracks what it created, and a new dev or review thread starts for each. The TUI marks created subjects.

### Removed

Everything in 1.0, with no migration: the hosted server and inbox, webhooks and sources, the MCP server, API tokens and login, the `read`/`poll`/`push` commands, and the install script. `packages/web` is now one static page.

## 1.0.0

loopway stops running bots and becomes a notification system for them. Every user has one inbox, and your own code reads it. What happens to a message is up to the reader.

### Changed

- **One inbox per user, at one URL.** `loopway inbox` shows it. Every sender gets the same URL, and loopway tells them apart by how they sign.
- **Inboxes became sources.** `loopway source register <type>` stores a sender's signing secret. A user can register several of a type, such as two GitHub orgs with different secrets. A delivery that no source verifies gets a `401` and isn't stored.
- **Messages last 14 days.** A message drops out of every read 14 days after it arrives, and a daily job deletes it.
- **The server's URL paths changed.** Reading is one endpoint, `GET /api/messages`, and the cron route is `/api/cron/tick`. See [docs/api.md](docs/api.md).

### Added

- **`loopway read <reader.js>`** hands a reader every message since its last read, one at a time and in order. **`loopway poll <reader.js>`** does the same until stopped. A reader's cursor moves past a message only once the reader has finished with it, so delivery is at least once.
- **Microsecond cursors.** A cursor is a time, so resetting one is `--since <time>`, not a guess at a number.
- **`loopway push`** and `POST /api/messages` put a message in your inbox.
- **A hosted MCP server** at `/api/mcp`, with `push_message` and `pull_messages` tools.
- **API tokens.** `loopway token create` makes a long-lived token for what runs unattended.

### Removed

- Bots, runners, threads, rules, presets, harnesses and the manager, with `loopway bots`, `loopway runners` and `loopway chats`.
- Orgs. A username now belongs to the user.
- The dashboard and web login. Everything but the landing page happens in the CLI.
- Event filters, inbox schemas and test messages.
- The `ee/` directory and its license. All of loopway is MIT-licensed.

### Moving from 0.x

- 0.x CLIs get a `426` from the server and update themselves. `loopway bots run` stops there: the command is gone, and it says so. Write a reader instead.
- Inboxes, messages, bots, threads and orgs aren't carried over. Users and usernames stay.
- A self-hosted deploy should update with its CLI: a 0.x server and a 1.0 CLI can't talk to each other.
- Every sender's webhook URL changes, so point each one at your new inbox URL and register its secret again.
