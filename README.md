# loopway

loopway is a notification system for your bots. Webhooks from the services you use (GitHub, Vercel, Linear, Granola and Resend), messages you push yourself and a schedule all land in one inbox, as [CloudEvents](https://github.com/cloudevents/spec). Your code reads the inbox and decides what to do with each message.

- Every user has one **inbox**, with one URL. Messages stay in it for 14 days.
- A **source** is something the inbox accepts: a sender's signing secret, or a schedule. A delivery that no source verifies is refused.
- A **reader** is a JS file you write. `loopway read` hands it each new message, in order.

It runs on Vercel at [loopway.craftmill.dev](https://loopway.craftmill.dev). To run your own copy, press the button (what it asks for is in [developing.md](docs/developing.md#deploy-with-the-vercel-button)):

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcraftmilldev%2Floopway&root-directory=packages%2Fweb&project-name=loopway&repository-name=loopway&env=TOKEN_SECRET%2CCRON_SECRET%2CINBOX_SECRET_KEY%2CRESEND_API_KEY%2CEMAIL_FROM&envDescription=Generate%20TOKEN_SECRET%20and%20CRON_SECRET%20with%20openssl%20rand%20-hex%2032%2C%20INBOX_SECRET_KEY%20with%20openssl%20rand%20-base64%2032%20%28keep%20a%20copy%29%3B%20RESEND_API_KEY%20and%20EMAIL_FROM%20for%20login%20emails&envLink=https%3A%2F%2Fgithub.com%2Fcraftmilldev%2Floopway%2Fblob%2Fmain%2Fdocs%2Fdeveloping.md%23deploy-with-the-vercel-button&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%2C%22protocol%22%3A%22storage%22%7D%5D)

- [`CHANGELOG.md`](CHANGELOG.md): what changed in each release, and how to move from 0.x.
- [`docs/sources/`](docs/sources/): one page per source ([github](docs/sources/github.md), [vercel](docs/sources/vercel.md), [linear](docs/sources/linear.md), [granola](docs/sources/granola.md), [resend](docs/sources/resend.md), [loopway](docs/sources/loopway.md), [schedule](docs/sources/schedule.md)): how to connect it, and how its deliveries map to CloudEvents.
- [`docs/api.md`](docs/api.md): the HTTP API and the MCP server.
- [`docs/developing.md`](docs/developing.md): running the server locally, deploying it, the repo layout, and adding a source.

## Getting started

```bash
curl -fsSL https://loopway.craftmill.dev/install.sh | sh   # puts `loopway` on your PATH; needs Node 22+
loopway login                       # emails you a one-time code; new emails get an account
loopway source register github      # stores a signing secret, and shows how to add the webhook
loopway inbox                       # your inbox URL: the same for every sender
```

Then write a reader:

```js
// reader.js
export default async function (msg, ctx) {
  if (msg.type === "com.github.pull_request.opened") {
    console.log(msg.subject, msg.data.pull_request.title);
  }
}
```

```bash
loopway read reader.js              # everything since the last read, then exit
loopway poll reader.js              # the same, and keep going
```

## Readers

A reader's default export is called once per message, oldest first, and each call is awaited.

- `msg` is the CloudEvent (`id`, `type`, `source`, `subject`, `time`, `data`) plus `message_id` (loopway's id for it), `received_at` (ISO 8601, to the microsecond) and `received_us` (the same time as microseconds since the epoch).
- `ctx.push({type, subject?, id?, data?})` puts a message in the same inbox. `ctx.signal` aborts when the command is stopping.
- **When it resolves,** the cursor moves past the message. **When it throws,** the cursor stays. `read` stops with an error and the message comes again on the next read. `poll` tries it again after a pause.

**Delivery is at least once.** A crash after your reader finishes a message and before its cursor is saved means that message comes again, and so do two `read`s of the same reader running at once. If a repeat would do harm, dedupe on `msg.message_id`. A reader that stays away for more than 14 days misses what expired, and `read` says so when it comes back.

**Cursors** are files in `~/.loopway/cursors`, one per reader file, user, server and `--type`. Moving or renaming a reader makes it a new reader. A new reader starts from now, so pointing one at your inbox can't replay 14 days of work. To start somewhere else, or go back:

```bash
loopway read reader.js --since 2h                           # how long ago: s, m, h or d
loopway read reader.js --since 2026-11-04T12:00:00.123456Z  # a time
loopway read reader.js --since 1793793600123456             # microseconds since the epoch
loopway read reader.js --type 'com.github.*'                # only these, with a cursor of their own
```

A cursor is a time, so `--since` with a message's `received_at` goes back to exactly that message. Messages reach readers about 5 seconds after they arrive: the read holds back the newest rows so one that's still being written can't be skipped.

`poll` checks every `--interval` seconds (default 5), slows to once a minute when quiet, and stops on Ctrl-C after finishing the message in hand. For something that runs unattended, use a token, which doesn't expire the way a login does:

```bash
loopway token create poller
LOOPWAY_API_KEY=lw_... loopway poll reader.js
```

## CLI

```bash
loopway login                          # emails you a code, trades it for a 30-day session, saves it (new emails get an account)
loopway whoami
loopway username [name]                # set or change your username
loopway config                         # the settings in use; `loopway config update` changes the API URL, metrics host or self-update
loopway clear-config                   # deletes ~/.loopway/config.json
loopway update                         # install the newest release now

loopway inbox                          # your inbox URL and what's in it

loopway source types                   # what can send to an inbox
loopway source register <type> [--name n] [--secret s]
loopway source register schedule --name clock --every day --hour 7 --message 'standup=Write the standup'   # see docs/sources/schedule.md
loopway source list
loopway source show <source>           # how its last delivery went
loopway source update <source> [--name n] [--secret s] [--every hour|day|week] [--hour 0-23] [--day mon] [--message type=text] [--message-file type=path] [--remove-message type]
loopway source remove <source>

loopway read <reader> [--since t] [--type t]
loopway poll <reader> [--since t] [--type t] [--interval seconds]

loopway push <type> [--subject s] [--id dedupe-id] [--data json | --data-file path]
loopway messages list [--since t] [--type t] [--limit 20] [--all]   # the newest, or with --since, everything from then on
loopway messages get <message> [--data]

loopway token create <name>            # shown once; doesn't expire
loopway token list
loopway token revoke <token>
```

- `<source>` and `<token>` are an id or a name.
- Every read command takes `--json` for the raw API response.
- `--type` is an exact CloudEvent type, or a prefix ending in `*`.
- For sources whose sender makes the secret (`vercel`, `granola`, `resend`, `linear`), register first, add the webhook in the sender, then give loopway the secret it shows with `loopway source update <source> --secret <secret>`.
- Credentials live in `~/.loopway/config.json` (`{ "api_url", "api_key" }`, mode 0600). `LOOPWAY_API_URL` / `LOOPWAY_API_KEY` override it, e.g. in CI. One login at a time. The URL defaults to `https://loopway.craftmill.dev`.

## MCP

loopway hosts an MCP server, so an agent can push to and pull from your inbox with no CLI installed. It has two tools, `push_message` and `pull_messages`. For Claude Code:

```bash
claude mcp add --transport http loopway https://loopway.craftmill.dev/api/mcp --header "Authorization: Bearer $(loopway token create claude-code --json | jq -r .token)"
```

## License

loopway is MIT-licensed; see [`LICENSE`](LICENSE).
