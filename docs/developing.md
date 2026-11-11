# Developing loopway

- **Stack:** TypeScript on Node 22, [vitest](https://vitest.dev), and three runtime dependencies: [`yaml`](https://eemeli.org/yaml/) for the front matter of bot files, [Ink](https://github.com/vadimdemedes/ink) and React for the TUI.
- **Packages:** npm workspaces: [`packages/cli`](../packages/cli) (the `loopway` command) and [`packages/web`](../packages/web) (one static marketing page, deployed to Vercel).
- **No server, no database.** Credentials are in `~/.loopway/config.json` (`LOOPWAY_HOME` moves it); state is JSON per project, in `~/.loopway/state/<slug>` (the slug is the path of its `.loopway` folder).

## Run it

```bash
npm install
npm run build
mkdir -p scratch/.loopway && cd scratch      # scratch/ is git-ignored
printf -- '---\nrepos: [owner/name]\non: issue\n---\nprompt\n' > .loopway/dev.md
printf -- '---\nrepos: [owner/name]\non: pull_request\n---\nprompt\n' > .loopway/review.md
npm run cli                                  # bare `loopway`, reading ./.loopway
npm run cli -- --no-tui                      # the plain log
npm run cli -- --json                        # NDJSON
npm run cli -- threads                       # the open threads, from another terminal
```

It needs `gh auth login`. Use a repo you can write to if you want to see events, and read the README for what it prints.

## Checks

```bash
npm test             # fake GitHub, no network
npm run typecheck
npm run lint
npm run format:check # `npm run format` fixes it
```

CI runs `npm run build` and these four.

## Layout of `packages/cli/src`

| File | What |
| --- | --- |
| `index.ts` | The command: reads `.loopway/`, wires the pieces, runs until Ctrl-C |
| `source.ts` | `SubjectSource`, the interface to a collaboration tool, and the types around it |
| `github.ts` | `GitHubSource`: REST with ETags, rate-limit detection |
| `poller.ts` | Discovery (2 min), updates (30 s), dedupe, backoff |
| `bots.ts` | Reads `.loopway/<bot>.md` |
| `rules.ts` | `decide(event, threads, bots) -> actions`: the thread rules, a pure function |
| `thread.ts`, `threads.ts` | The `Thread` type; the store that applies the rules' actions and keeps `threads/<id>.json` |
| `sessions.ts` | Delivers each thread's queue to its session (`--max`, resume, requeue on failure, usage-limit hold), and records what it sends |
| `claude.ts`, `transcript.ts` | The Claude Code harness: `claude -p` args, spawn, how a run ended, and the stream turned into log lines |
| `mcp.ts` | loopway's MCP server (HTTP, one path per thread) with the `comment` tool |
| `config.ts`, `state.ts` | `~/.loopway/config.json`'s `github` block, and `stateDir`, where `state.json` and the threads live |
| `tui.tsx`, `tui-main.tsx`, `tui-thread.tsx`, `tui-text.ts` | The [Ink](https://github.com/vadimdemedes/ink) TUI: the main view, the thread view, and the subject filter. Reads threads from the in-process store and the session log from disk |
| `format.ts` | The printed line, and `--json` |

Tests fake the source (`test/fake.ts`) for the poller, and fake `fetch` for `GitHubSource`. `test/fake-claude.mjs` stands in for `claude`: it emits stream-json and, in `comment` mode, calls the MCP tool.

## The marketing page

`packages/web/public/index.html` is the whole site. `packages/web/vercel.json` serves `public/` with no install or build, and `scripts/should-build.mjs` (the `ignoreCommand`) skips deploys when nothing in `packages/web` changed. Verifications for each PR live in `verifications/`.
