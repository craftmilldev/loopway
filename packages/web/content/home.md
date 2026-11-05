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
-->

## A Craftmill project {#top}

# A notification system for your bots.

Loopway is a project, not a service. It told an agent when there was work to do: a call ended, an email landed, an issue was filed, and a bot picked it up, on Claude Code, Codex, Cursor or Hermes. We built it, ran our own work on it for a few weeks and put it down. It takes no new accounts, and the code is open on [GitHub](https://github.com/craftmilldev).

## Listened to {#listens}

- **GitHub** · **Linear** · **Vercel** · **Granola** · **Resend** · **a clock** · **other bots**

Each one became a CloudEvent in an inbox, and bots read their inboxes in order.

## What it did {#first}

### A call ends, and the action items are in your tracker

The first bot we ran filed the action items from call notes. You never opened loopway to see it work: the tasks showed up in the tracker already in use.

1. **The call ends** — Granola saves the notes, and loopway puts the event in your bot's inbox.
2. **The bot reads the note** — Your agent, with the bot's prompt, finds the clear action items and leaves the vague ones alone.
3. **The tasks appear** — Each one is an issue in Linear or GitHub, or a card in Trello or Asana if your agent has that connected.

## Why we built it {#levels}

### Most of us sit at level 2, and the tools keep us there

Agents wait to be asked, so the work starts with a person. Loopway was an attempt to make the other levels the default: give a bot a role, a set of events to listen to, and rules for which thread each event joins. loopway recorded the level of every thread, so you could see the work move up.

- **Level 1 · Assisted** — You ask a model, read the answer, and do the work yourself. Nothing for loopway to run.
  *You start it. You do it.*
- **Level 2 · You start it** — A person opens the issue or sends the message, and a bot carries the work from there.
  *You start it. A bot does it.*
- **Level 3 · A bot starts it, you take part** — A call ending, a deploy or a schedule starts the work. The bot asks when it needs a decision, where you already are: a comment, a review, an issue.
  *A bot starts it. You answer it.*
- **Level 4 · No one has to** — Bots start the work and finish it, handing it to each other. You read the results and change the rules, not the work.
  *Bots start it. Bots finish it.*

## How it was built {#runners}

### The inboxes were hosted; the bots ran on your own agent

The inboxes lived on a server. The bots ran wherever you started the runner, on the agent subscription you already paid for, with the permissions your agent's own settings allowed. Three bots built most of loopway itself: a planner, an implementer and a reviewer, and one person reading what they made.

## What we learned {#learned}

### Engineers build this themselves, and the agent vendors will too

About thirty conversations with software engineers found no pull. People who are comfortable with agents wire up their own triggers in an afternoon, and the question that kept coming back was why the agent's own vendor wouldn't just ship this. We had no good answer, so we stopped. The idea that held up: agents should hear about work as it happens, and bots with roles are a better frame than one assistant.

## Examples {#examples}

### Bots you could run

These are examples, not the bots we ran ourselves. Each is a prompt and a few rules, on the agent that suits it.

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

## The code {#start}

### It's open, so run your own.

loopway is open source and MIT-licensed. The source, the docs and how to deploy your own copy are on GitHub.

[Craftmill on GitHub](https://github.com/craftmilldev)
[Read the code](https://github.com/craftmilldev/loopway)

## Colophon {#colophon}

Loopway · a Craftmill project · Plumbline LLC, Maine
