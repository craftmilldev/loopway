# bb-plugin-loopway

`loopway bots run`, as a bb plugin. While the plugin is enabled, it runs this machine's loopway bots for one
org. Each loopway thread's messages go to a bb thread of its own instead of a headless `claude -p` session.

- `server.ts` sets up the settings, the background `runner` service, the `loopway_end` and `loopway_link`
  agent tools, the thread lifecycle listeners, the page's `state` RPC, and `bb loopway status`.
- `status.ts` holds the RPC contract and the snapshot behind the **Loopway** page, plus `RunnerStatus`: the
  runner's phase.
- `app.tsx` is the **Loopway** page in the left sidebar. It shows the runner's status, the bots, and each
  loopway thread with a link to its bb thread. It refetches when the server publishes `state-changed`, which
  it does when the runner's phase changes or it logs a line (a run starting or ending, say).
- `sessions.ts` holds `BbSessions`, the harness the dispatcher runs. It keeps the loopway thread ↔ bb thread
  map in the plugin's kv and starts or messages bb threads. Each run lasts until its bb thread is idle with
  nothing queued.
- `skills/loopway-runner/SKILL.md` documents the plugin for agents.

The polling, leasing, routing, delivery and retries are the CLI's `Dispatcher`
(`packages/cli/src/bots/dispatcher.ts`). The plugin imports it from source as `@loopway/cli/src/...` and
bundles it in. (bb refuses `../` imports that leave the plugin directory, so the plugin is an npm workspace
and depends on `@loopway/cli`.) That means it installs only from a loopway checkout after `npm ci`, not
from git or npm on its own. The plugin passes `BbSessions.run` as the dispatcher's `runAgent`. It calls the
session tools through `Dispatcher.callTool` rather than the MCP URL.

## Develop

From the repo root, run `npm ci` first. The plugin is a workspace, so this installs its dependencies and
builds the CLI's workspace packages. Then:

```
npm test -w bb-plugin-loopway
npm run typecheck -w bb-plugin-loopway
cd packages/bb-plugin-loopway
bb plugin build              # optional: checks the bundle without installing
bb plugin install .          # path install; loads server.ts in place
bb plugin config loopway set project <project id>
bb plugin logs loopway -f
```

The runner registers as `<hostname> (bb)` and keeps its runner id and per-thread run logs in
`~/.loopway/bb-runner/`, apart from the CLI's `~/.loopway/runner.json`. A loopway thread belongs to the
runner that claimed it, and only this runner has bb threads to send its messages to.

## Stopping and restarting

Stopping the plugin, by disabling or reloading it or by changing a setting, releases the leases. bb threads
that are mid-turn keep running. Each run writes an `init` record to its log when the bb thread gets the
message, and a `result` record when the turn ends. On the next start, the dispatcher's reconcile finds the runs
that have no `result` and puts their messages back to waiting. Those messages then go to the same bb thread
again.
