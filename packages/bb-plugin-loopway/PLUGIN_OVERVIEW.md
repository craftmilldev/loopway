Run your loopway bots in bb instead of in a terminal.

## What you get

- A loopway runner that starts when the plugin is enabled and stops when it is disabled.
- One bb thread for each loopway thread. You can watch each bot thread work, and step in, like any other
  thread.
- `loopway_end` and `loopway_link` tools in those threads. They match the `end` and `link` tools that
  `loopway bots run` gives its sessions.
- `bb loopway status`, which shows which bb thread each loopway thread maps to.

## How it works

The plugin runs the same dispatcher as `loopway bots run`. It polls loopway, leases the org's bots, and routes
each message to a loopway thread using the bot's rules. Instead of starting `claude -p`, it starts a bb thread
in the project you choose, or sends the message to the bb thread the loopway thread already has. It uses the
API key that `loopway login` saved, unless you set one.
