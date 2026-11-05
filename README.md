# loopway

loopway is a notification system for your bots. It accepts webhooks from the services you already use (GitHub, Vercel, Linear, Granola and Resend), plus messages you push yourself and a schedule that fills on a clock, and stores each one as a [CloudEvent](https://github.com/cloudevents/spec) for 14 days. Your code reads them, and decides what to do with them.

> **This is the v2 branch, mid-rewrite.** The bot runner, threads, rules, orgs and dashboard are gone, and the single inbox, `loopway read` and `loopway poll` aren't built yet. [`docs/v2.md`](docs/v2.md) has the design and what's left. Today the CLI logs in, manages inboxes and lists messages.

- A **user** logs in with an emailed code.
- An **inbox** holds one source's webhook secret and receives its deliveries.
- A **message** is a stored delivery: the CloudEvent and when it arrived. Nothing is marked done.

It runs on Vercel at [loopway.craftmill.dev](https://loopway.craftmill.dev). To run your own copy, press the button (what it asks for is in [developing.md](docs/developing.md#deploy-with-the-vercel-button)):

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcraftmilldev%2Floopway&root-directory=packages%2Fweb&project-name=loopway&repository-name=loopway&env=TOKEN_SECRET%2CCRON_SECRET%2CINBOX_SECRET_KEY%2CRESEND_API_KEY%2CEMAIL_FROM&envDescription=Generate%20TOKEN_SECRET%20and%20CRON_SECRET%20with%20openssl%20rand%20-hex%2032%2C%20INBOX_SECRET_KEY%20with%20openssl%20rand%20-base64%2032%20%28keep%20a%20copy%29%3B%20RESEND_API_KEY%20and%20EMAIL_FROM%20for%20login%20emails&envLink=https%3A%2F%2Fgithub.com%2Fcraftmilldev%2Floopway%2Fblob%2Fmain%2Fdocs%2Fdeveloping.md%23deploy-with-the-vercel-button&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%2C%22protocol%22%3A%22storage%22%7D%5D)

- [`docs/v2.md`](docs/v2.md): the v2 design.
- [`docs/sources/`](docs/sources/): one page per source ([github](docs/sources/github.md), [vercel](docs/sources/vercel.md), [linear](docs/sources/linear.md), [granola](docs/sources/granola.md), [resend](docs/sources/resend.md), [loopway](docs/sources/loopway.md), [schedule](docs/sources/schedule.md)): its config, how to connect it, and how its deliveries map to CloudEvents.
- [`docs/api.md`](docs/api.md): the HTTP API and the webhook ingestion rules.
- [`docs/developing.md`](docs/developing.md): running the server locally, deploying it, the repo layout, and adding a source.

## CLI

`loopway` lives in `packages/cli` and talks to the API over HTTP.

```bash
curl -fsSL https://loopway.craftmill.dev/install.sh | sh       # puts `loopway` on your PATH; needs Node 22+
npm run cli -- <command>                                       # or from the repo, no build
```

```bash
loopway config                         # the settings in use; `loopway config update` changes the API URL, metrics host or self-update
loopway login                          # emails you a one-time code, trades it for a 30-day session token, saves it (new emails get an account)
loopway username [name]                # set or change your username
loopway whoami
loopway clear-config                   # deletes ~/.loopway/config.json
loopway update                         # install the newest release now

loopway inbox create                   # interactive: name → source → events → secret → confirm
loopway inbox list
loopway inbox show <inbox>             # webhook setup + message count
loopway inbox test <inbox>             # send the inbox a sample message of its source
loopway inbox update <inbox> [--name n] [--events a,b] [--secret s] [--schema file.json]   # with no flags in a terminal, asks for the secret
loopway inbox update <schedule-inbox> [--every hour|day] [--hour 0-23] [--message type=text] [--message-file type=path] [--remove-message type] [--config file.json]   # see docs/sources/schedule.md

loopway messages list <inbox> [--type 'com.github.pull_request.*'] [--limit 20] [--all]
loopway messages get  <inbox> <message> [--data]
```

- `<inbox>` is an inbox id or its exact name.
- Every read command takes `--json` for the raw API response.
- `inbox create` skips any prompt whose flag is given; without a terminal it runs from flags alone. For sources whose sender makes the secret (`vercel`, `granola`, `resend`, `linear`) it doesn't ask for one: add the webhook in the sender, then paste the secret it shows with `loopway inbox update <inbox>`.
- Credentials live in `~/.loopway/config.json` (`{ "api_url", "api_key" }`, mode 0600). `LOOPWAY_API_URL` / `LOOPWAY_API_KEY` override it, e.g. in CI. The URL defaults to `https://loopway.craftmill.dev`.

## License

loopway is MIT-licensed; see [`LICENSE`](LICENSE).
