loopway is a place to build bots and work alongside them. A bot watches the services you already use (GitHub, Vercel and Granola so far), gets each thing that happens there as a message in its inbox, and works through them one at a time. The bot can be a script, a cron job or a Claude agent.

## Install

```
curl -fsSL https://loopway.craftmill.dev/install.sh | sh
```

This puts the `loopway` CLI on your PATH. It needs Node 22+. Read the [install script](/install.sh) first if you like.

## Make a bot

1. [Log in](/login) with your email. New emails get an account.
2. Create an inbox for your bot from your org's page and pick the service it listens to. The page also shows your bots, the runners they run on, and their threads.
3. Connect the service with the URL and secret the inbox gives you (Vercel and Granola give you a secret to paste back into loopway instead).
4. Create a bot that reads the inbox, and run it with the CLI or the API.

## Run an agent

```
loopway bots create --name dev --preset github-threads --model sonnet --inbox <inbox>
loopway bots run
```

`bots run` turns an inbox into a Claude agent. It starts a Claude Code session for each issue and its PR, which picks up new comments and reviews as they come in and keeps working until the thread is done. You watch the sessions, read their transcripts, and step in on GitHub like you would with a teammate.

## Write your own

```
loopway login
loopway inbox list
loopway bots create --name dev --preset github-threads --model sonnet --inbox <inbox>
loopway bots run
```

A bot reads its inboxes in arrival order and keeps a cursor, so it picks up where it left off. `loopway bots run` runs yours; `loopway messages list <inbox>` and `loopway messages get <inbox> <message>` read what's in an inbox.

## The API

```
curl -H "Authorization: Bearer $TOKEN" \
  $URL/bots/$BOT/messages
```

Every endpoint takes the session token you get from logging in.
