<!--
Every word on the home page (/). The page is built from this file: edit it here and the site changes.

How the page reads it:
- `## Label {#id}` starts a section. The label is the small typewritten line above the heading. `#id` is the anchor
  the nav links to, and it picks the section's layout (and the figure beside it, if it has one).
- `#` is the headline, used once, in the first section. `###` is every other section's heading.
- Paragraphs under the heading are its prose.
- A list is the section's columns or items. Each item is `**Title**`, then ` — `, then its text. An indented line in
  italics under an item is that column's footnote.
- A `[link](url)` alone on a line is a button. The first one in a section is the solid one. The last section (`#start`)
  has no buttons: a link alone on a line there is a plain text link.
- A fenced code block is a terminal well. Its info string is the well's label (`install`, `cli`, `http`). The
  `install` well wraps a long command onto a second line; the others scroll sideways.
- `{agents}` is replaced with the coding agents a bot can run on (the harness labels in packages/harnesses).
- Sample data in the figures (the terminal, the thread, the bots table) lives in the page code, not here.
-->

## A runner for bots {#top}

# Bots that run your process, and *ask* when they need you.

loopway listens to the services you already use, keeps every event in an inbox, and hands them to bots running on your machines. A bot is a prompt and a few rules, run by the coding agent you pick: {agents}.

```install
curl -fsSL https://loopway.craftmill.dev/install.sh | sh
loopway login
```

The login emails you a one-time code. New emails get an account.

## Listens to {#listens}

- **GitHub** · **Linear** · **Vercel** · **Granola** · **Resend** · **a clock** · **other bots**

Need another? Ask for it from the dashboard.

## Levels of automation {#levels}

### From starting every piece of work to writing the rules it runs by

loopway records the level of every thread. One a person starts is level 2. One a bot starts is level 3 if a person takes part, and level 4 if no one does. The dashboard shows each bot's threads by level, so you can see the work move up.

- **Level 1 · Assisted** — You ask a model, read the answer, and do the work yourself. Nothing for loopway to run.
  *You start it. You do it.*
- **Level 2 · You start it** — A person opens the issue or sends the message, and a bot carries the work from there.
  *You start it. A bot does it.*
- **Level 3 · A bot starts it, you take part** — A deploy, a schedule or another bot starts the work. The bot asks when it needs a decision, where you already are: a comment, a review, an issue.
  *A bot starts it. You answer it.*
- **Level 4 · No one has to** — Bots start the work and finish it, handing it to each other. You read the results and change the rules, not the work.
  *Bots start it. Bots finish it.*

## Bots {#bots}

### Bots you could run

These are examples, not the bots we run ourselves. Each is a prompt and a few rules, on the agent that suits it. A request someone sends from the dashboard can become a reviewed pull request without anyone starting the work.

A level 4 loop:

1. **loopway inbox** — A request from the dashboard
2. **intake** — Files a ready issue
3. **issue-to-pr** — Opens the pull request
4. **second-look** — Reviews it, issue-to-pr answers

The bots:

- **intake** — Checks each request sent from the dashboard and files the real ones as issues.
  *Claude Code · loopway*
- **issue-to-pr** — Works each ready issue through to a pull request, then follows its reviews and CI.
  *Claude Code · GitHub*
- **second-look** — Reviews each pull request and talks its feedback through. It never changes the code.
  *Codex · GitHub*
- **deploy-medic** — When a production deploy fails, finds out why and files an issue so it gets fixed.
  *Cursor · Vercel*
- **backlog-sweep** — Each morning, closes stale issues and asks about the unclear ones.
  *Codex · Linear, a daily schedule*
- **notes-to-tasks** — When meeting notes land, files their action items as issues.
  *Hermes · Granola*
- **bounce-check** — When an email bounces, checks the address and flags the account.
  *Hermes · Resend*
- **Yours** — Start from a preset or from blank. A bot is a prompt and the rules that say which events it takes.
  *Your agent · your inboxes*

## How it works {#how}

### From an event to finished work

Each part keeps one fact and passes the rest along. Nothing is locked and nothing is marked done, so an event is never lost to a crash.

1. **Source** — A service you use, a schedule, or another bot sends an event to the inbox. The inbox checks its signature.
2. **Inbox** — Keeps each event as a CloudEvent, in the order it arrived. Messages are a record to read from, not a queue to drain.
3. **Bot** — Reads its inboxes with a cursor, so it picks up where it left off. Its rules decide which thread each event belongs to.
4. **Runner** — Your machine, running `loopway bots run`. It leases each bot, so two runners never do the same work.
5. **Session** — The bot's agent, started with its prompt. It does the job, asks when it needs to, and ends the thread when the work is done.

## Threads {#threads}

### A thread is one piece of work and every event about it

Every later event for the same work lands in the same session, so the bot remembers what it already tried. When it needs you, it asks where you already work, and the next run reads your answer.

- Rules match on event type and subject. A subject no thread holds starts a new one.
- A thread ends when the bot says the work is done. Its next event wakes it.
- You can write to a thread from the dashboard or the terminal, and every transcript stays on the runner that wrote it.

## Runners {#runners}

### It runs on your machine, with your own agents

We host the inboxes and the threads. The sessions run where you start the runner, on the agent accounts you already pay for.

- **Leases** — Each tick the runner renews its lease on every bot it holds. A second runner skips a held bot and says until when. Quit, crash or close the lid, and the lease is released or runs out.
- **Your agent's settings** — Sessions run as you, in the bot's checkout, with whatever permissions your agent's own settings allow.
- **Usage limits** — When an agent reports a usage limit, the runner stops delivering until it resets, then carries on. Events keep arriving and wait on their threads.
- **Versions** — A bot's prompt and rules are saved together as a version. Running threads keep the version they started on.

## The dashboard {#dashboard}

### One word for what each bot is doing

When the work runs without you, you need to see it at a glance: is anything stuck, what are my bots doing, and how much of it ran without anyone.

- **stranded** — Owns threads on a runner whose lease has run out.
- **limited** — A thread hit a usage limit and waits for it to reset.
- **working** — A run is in flight on one of its threads.
- **waiting** — Open threads, nothing in flight.
- **idle** — No open threads.

Levels:

- **Level 2** — a person started it
- **Level 3** — a bot started it, a person took part
- **Level 4** — no person took part

## Write your own {#api}

### A bot is a prompt, its rules, and an agent to run them

Pick the agent and model, write the prompt, and add rules that say which events it takes and how they group into threads. Or skip the runner and read the inbox yourself: every read command in the CLI takes `--json`.

[The HTTP API](https://github.com/craftmilldev/loopway/blob/main/docs/api.md) · [The CLI](https://github.com/craftmilldev/loopway#cli)

```cli
loopway inbox create --name vercel-prod --source vercel
loopway bots create --name deploys --harness codex --inbox vercel-prod
loopway bots run
```

```http
curl -H "Authorization: Bearer $TOKEN" \
    https://loopway.craftmill.dev/api/bots/$BOT/messages
```

## Sources {#sources}

### Seven sources so far, and loopway is one of them

An inbox listens to one source. A bot can read several, so a failed deploy and the issue it caused can land in the same thread.

- **GitHub** — Issues, comments, pull requests, reviews, pushes and CI, from a repository or an organization.
  *`source_type: "github"`*
- **Linear** — A workspace's issues and the comments on them.
  *`source_type: "linear"`*
- **Vercel** — A team's deployments, as they start, fail and finish.
  *`source_type: "vercel"`*
- **Granola** — Meeting notes from a workspace or a folder.
  *`source_type: "granola"`*
- **Resend** — What happens to the email you send and receive: delivered, bounced, opened, clicked.
  *`source_type: "resend"`*
- **Schedule** — A message each hour, or each day at an hour you pick, to wake a bot on a rhythm.
  *`source_type: "schedule"`*
- **loopway** — Messages posted straight to an inbox, so bots and backends can message each other.
  *`source_type: "loopway"`*

## Start {#start}

### Start with one inbox and one bot.

Log in with your email, point a webhook at an inbox, give a bot a prompt and its rules, and run `loopway bots run`. The next event is its first thread.

```install
curl -fsSL https://loopway.craftmill.dev/install.sh | sh
loopway login
```

[View on GitHub](https://github.com/craftmilldev/loopway)

loopway is open core. Everything is MIT-licensed except `packages/web/ee`.

## Colophon {#colophon}

Loopway · a Craftmill works · Plumbline LLC, Maine
