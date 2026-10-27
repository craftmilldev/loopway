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
- Sample data in the figure (the terminal) lives in the page code, not here.
-->

## For the one who is always the trigger {#top}

# A notification system for your bots.

Your agent waits for you. Loopway tells it when there's work: a call ends, an email lands, an issue is filed, and a bot picks it up. It runs on your machine, on {agents}.

```install
curl -fsSL https://loopway.craftmill.dev/install.sh | sh
loopway login
```

The login emails you a one-time code. New emails get an account.

## Listens to {#listens}

- **GitHub** · **Linear** · **Vercel** · **Granola** · **Resend** · **a clock** · **other bots**

Need another? Ask for it from the dashboard.

## Your first bot {#first}

### A call ends, and the action items are in your tracker

The first bot most people run files the action items from their call notes. You never open loopway to see it work: the tasks show up in the tracker you already use.

1. **The call ends** — Granola saves the notes, and loopway puts the event in your bot's inbox.
2. **The bot reads the note** — Your agent, with the bot's prompt, finds the clear action items and leaves the vague ones alone.
3. **The tasks appear** — Each one is an issue in Linear or GitHub, or a card in Trello or Asana if your agent has that connected.

## You choose how much it does alone {#levels}

### Will it mess things up? Start with you approving, and turn it up one task at a time

loopway records the level of every thread, so you can see the work move up as you trust the bot more.

- **Level 1 · Assisted** — You ask a model, read the answer, and do the work yourself. Nothing for loopway to run.
  *You start it. You do it.*
- **Level 2 · You start it** — A person opens the issue or sends the message, and a bot carries the work from there.
  *You start it. A bot does it.*
- **Level 3 · A bot starts it, you take part** — A call ending, a deploy or a schedule starts the work. The bot asks when it needs a decision, where you already are: a comment, a review, an issue.
  *A bot starts it. You answer it.*
- **Level 4 · No one has to** — Bots start the work and finish it, handing it to each other. You read the results and change the rules, not the work.
  *Bots start it. Bots finish it.*

## Runs on your machine {#runners}

### Your data stays with you, on your own agent

We host the inboxes. The bots run where you start the runner, on the agent subscription you already pay for, with the permissions your agent's own settings allow. Nothing else is hosted.

## Examples {#examples}

### Bots you could run

These are examples, not the bots we run ourselves. Each is a prompt and a few rules, on the agent that suits it.

For your work:

- **call-notes** — When meeting notes land, files their action items in your tracker.
  *Granola*
- **email-triage** — Sorts what lands in your inbox and drafts replies for the ones that need you.
  *Resend*
- **requests-to-tasks** — Turns each request sent to loopway into a task, or asks what it's missing.
  *loopway*

For your code:

- **issue-to-pr** — Works each ready issue through to a pull request, then follows its reviews and CI.
  *GitHub*
- **second-look** — Reviews each pull request and talks its feedback through. It never changes the code.
  *GitHub*
- **deploy-medic** — When a production deploy fails, finds out why and files an issue so it gets fixed.
  *Vercel*

## Start {#start}

### Start with one bot.

Install loopway, log in with your email, and run the bot that files your call notes as tasks. The next call you finish is its first thread.

```install
curl -fsSL https://loopway.craftmill.dev/install.sh | sh
loopway login
```

[View on GitHub](https://github.com/craftmilldev/loopway)

loopway is open core. Everything is MIT-licensed except `packages/web/ee`.

## Colophon {#colophon}

Loopway · a Craftmill works · Plumbline LLC, Maine
