---
name: loopway-runner
description: How the loopway runner plugin hands loopway bot threads to bb threads, how to check on it with `bb loopway status`, and what a bb thread that is a loopway thread should do.
---

# Loopway runner

The loopway runner plugin does what `loopway bots run` does, inside bb. While it is enabled, it polls
loopway for the bots of one org, routes their messages to loopway threads, and hands each loopway thread's
messages to a bb thread of its own:

- A new loopway thread gets a new bb thread in the plugin's project, started with the bot's prompt and the
  messages.
- Later messages for that loopway thread go to the same bb thread.
- If that bb thread is deleted, the next message starts a new one.

The plugin keeps the map between loopway threads and bb threads. A loopway thread counts as running until its
bb thread is idle with nothing queued. At most `max` threads run at once.

## Checking on it

The **Loopway** page in bb's left sidebar shows the runner's status, its bots, and each loopway thread with a
link to its bb thread. From a terminal:

```
bb loopway status
```

This shows the org, the runner, the bots it holds, and each of this runner's loopway threads with its status,
its bb thread, and its subjects. If the runner isn't running, `bb plugin list` says why: usually a missing
setting, or `loopway login` not done yet.

## Settings

Set these with `bb plugin config loopway set <key> <value>`:

- `project`: the bb project new threads start in (required).
- `org`: the loopway org slug. Needed only when the user belongs to several orgs.
- `max`: most loopway threads running at once (default 3).
- `interval`: seconds between polls (default 5).
- `apiKey`: a loopway API key, if not the one `loopway login` saved.

The runner registers with loopway as `<hostname> (bb)`. It keeps its own runner id in
`~/.loopway/bb-runner/`, so it is a different runner from the CLI's. The plugin and `loopway bots run` can run the same bots at
once: each claims the threads it has room for, and a thread stays with the runner that claimed it.

## In a bb thread that is a loopway thread

If a GitHub bot is set up with `loopway config update`, `gh` and git in these threads act as the bot, and
commits are the bot's. `GH_CONFIG_DIR` points `gh` at the runner's own login, and git gets its github.com
credentials from `gh`. Don't set `GH_TOKEN`, and don't run `gh auth login` there.

The plugin gives these threads two tools. They are the same as the `end` and `link` tools that
`loopway bots run` gives its sessions:

- `loopway_end` ends the loopway thread when its work is finished. A later event for the thread sends the bb
  thread a message again.
- `loopway_link` makes the loopway thread track one more issue or PR, so that subject's events come to this
  bb thread too.

Both tools work only while the runner has a run in flight for the thread, which is while the thread is
handling a message that loopway sent. Messages list loopway message ids; read one with
`loopway messages get <inbox> <id> --data`.
