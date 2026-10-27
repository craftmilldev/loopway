Run your loopway bots in bb instead of in a terminal.

## What you get

- A loopway runner that starts when the plugin is enabled and stops when it is disabled.
- One bb thread for each loopway thread. You can watch each bot thread work, and step in, like any other
  thread.
- If you've set up a GitHub bot with `loopway config update`, those threads act on GitHub as the bot, as
  `loopway bots run` sessions do.
- `loopway_end` and `loopway_link` tools in those threads. They match the `end` and `link` tools that
  `loopway bots run` gives its sessions.
- A **Loopway** page in the sidebar. It shows the runner's status and the bots it holds. It lists each loopway
  thread with its status, its waiting messages, and a link to its bb thread.
- `bb loopway status`, the same overview from a terminal.

## How it works

The plugin runs the same dispatcher as `loopway bots run`. It polls loopway for the work the server has routed to loopway threads
(using the bots' rules) and claims what it has room for. Instead of starting `claude -p`, it starts a bb thread
in the project you choose, or sends the message to the bb thread the loopway thread already has. It uses the
API key that `loopway login` saved, unless you set one.
