# Developing loopway

- **Stack:** TypeScript on Node 22, [vitest](https://vitest.dev), and three runtime dependencies: [`yaml`](https://eemeli.org/yaml/) for the front matter of bot files, [Ink](https://github.com/vadimdemedes/ink) and React for the TUI.
- **Packages:** npm workspaces: [`packages/cli`](../packages/cli) (the `loopway` command) and [`packages/web`](../packages/web) (one static marketing page, deployed to Vercel).
- **No server, no database.** Credentials are in `~/.loopway/config.json` (`LOOPWAY_HOME` moves it); state is JSON per project, in `~/.loopway/state/<slug>` (the slug is the path of its `.loopway` folder).

## Run it

```bash
npm install
npm run build
npm run init-scratch                      # scratch/ (git-ignored): dev and review bots on the sandbox repo
cd scratch
node ../packages/cli/dist/index.js                                   # bare `loopway`, reading ./.loopway
node ../packages/cli/dist/index.js --no-tui                      # the plain log
node ../packages/cli/dist/index.js --json                        # NDJSON
node ../packages/cli/dist/index.js threads                       # the open threads, from another terminal
```

It needs `gh auth login`. `npm run init-scratch` points both bots at `craftmilldev/loopway-sandbox`; run it again any time (it keeps bot files you edited and says so; `--force` puts the defaults back). `-- --reset` also clears the project's state in `~/.loopway/state/`, so you start with no threads, and `-- --dir <path>` makes the project somewhere else. Read the README for what loopway prints.

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
| `mcp.ts` | loopway's MCP server (HTTP, one path per thread) with the `comment`, `ask`, `create_issue`, `create_pr` and `permission` tools |
| `asks.ts` | Asks: the allow/deny rule matching, the comments loopway posts to ask, and reading the owner's reactions |
| `config.ts`, `state.ts` | `~/.loopway/config.json`'s `github` block, and `stateDir`, where `state.json` and the threads live |
| `tui.tsx`, `tui-main.tsx`, `tui-thread.tsx`, `tui-text.ts` | The [Ink](https://github.com/vadimdemedes/ink) TUI: the main view, the thread view, and the subject filter. Reads threads from the in-process store and the session log from disk |
| `format.ts` | The printed line, and `--json` |

`tools/init-scratch.mjs` (`npm run init-scratch`) is a plain Node script, outside the packages; `test/init-scratch.test.ts` runs it in a temp dir.

Tests fake the source (`test/fake.ts`) for the poller, and fake `fetch` for `GitHubSource`. `test/fake-claude.mjs` stands in for `claude`: it emits stream-json and, in `comment`, `ask`, `open` and `permission` modes, calls the MCP tool.

## The marketing page

`packages/web/public/index.html` is the whole site. `packages/web/vercel.json` serves `public/` with no install or build, and `scripts/should-build.mjs` (the `ignoreCommand`) skips deploys when nothing in `packages/web` changed. Verifications for each PR live in `verifications/`.

The page is the billboard (`public/billboard/`, in a full-window iframe) with five frames that scrolling steps through: the sign itself (wordmark and tagline), then cards for the description, install, getting started and the GitHub link. Wheel, swipe, arrow, PageUp/PageDown and space keys step one frame; the billboard passes them up with `postMessage` because the iframe gets them first. The install host is the one `loopway.craftmill.dev` in `index.html`; change it there if the site moves.

The billboard keeps what has been found in `localStorage` (`loopway.found`: `snake`, `bird`, `loops`) and tells the page; the tracker on the last card reads it. PostHog gets `frame_viewed` (`frame`, `name`, `from`), `snake_found` and `bird_found` (the first time only), `install_copied` and `github_clicked`, plus the page view, for a funnel. A find made on `/billboard/` by itself is kept too, so it uses up the first time and the page never sends that event. `?u=` and `?speed=` on `/billboard/` still freeze and speed up the day.
