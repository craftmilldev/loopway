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

A call ends, a deploy fails, a pull request opens. Loopway puts each of those in one inbox, and your own code reads it, wherever that code runs.

```install
curl -fsSL https://loopway.craftmill.dev/install.sh | sh
```

## Listens to {#listens}

- **GitHub** · **Linear** · **Vercel** · **Granola** · **Resend** · **a clock** · **you**

Each one becomes a CloudEvent in your inbox, and stays for 14 days.

## How it works {#first}

### One URL in, one function out

Agents wait to be asked. Loopway tells them when there's work to do, and leaves what happens next to you.

1. **Register a sender** — `loopway source register github` stores its signing secret. Anything loopway can't verify is refused.
2. **Give it your inbox** — You have one URL, and every sender uses it.
3. **Write a reader** — A function that takes one message. `loopway read` calls it for each new one, in order.

## A reader {#reader}

### It's a file you own

Start a Claude session, file an issue, post to Slack, or do nothing. Loopway never needs to know.

```reader.js
export default async function (msg) {
  if (msg.type === "ai.granola.note.generated") {
    await fileActionItems(msg.data);
  }
}
```

```cli
loopway read reader.js    # everything since the last read
loopway poll reader.js    # and keep going
```

## What it promises {#promises}

### Simple rules you can build on

- **At least once** — The cursor moves past a message when your reader finishes with it. If your reader throws, that message comes again.
- **Time is the cursor** — Every read is from a microsecond timestamp, so going back is `--since` a time, not a guess at a number.
- **Your own machine** — Your readers run where you run them, on your own agent, with your own permissions.

## For agents {#agents}

### Push and pull over MCP

A hosted MCP server gives an agent the same inbox with no CLI installed: one tool to push a message, and one to pull them.

## The code {#start}

### It's open, so run your own.

loopway is open source and MIT-licensed. The source, the docs and how to deploy your own copy are on GitHub.

[Craftmill on GitHub](https://github.com/craftmilldev)
[Read the code](https://github.com/craftmilldev/loopway)

## Colophon {#colophon}

Loopway · a Craftmill project · Plumbline LLC, Maine
