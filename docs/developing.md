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
| `sessions.ts` | Delivers each thread's queue to its session (`--max`, resume, requeue on failure, usage-limit hold), and records what it sends. Also the TUI's chat blocks: messages from the owner go to the session in order, the queue waits, and the end of the block tells the session to report |
| `claude.ts`, `transcript.ts` | The Claude Code harness: `claude -p` args, spawn, how a run ended, and the stream turned into log lines |
| `mcp.ts` | loopway's MCP server (HTTP, one path per thread) with the `comment`, `ask`, `create_issue`, `create_pr` and `permission` tools |
| `asks.ts` | Asks: the allow/deny rule matching, the comments loopway posts to ask, and reading the owner's reactions |
| `config.ts`, `state.ts` | `~/.loopway/config.json`'s `github` block, and `stateDir`, where `state.json` and the threads live |
| `tui.tsx`, `tui-main.tsx`, `tui-thread.tsx`, `tui-text.ts` | The [Ink](https://github.com/vadimdemedes/ink) TUI: the main view, the thread view, and the subject filter. Reads threads from the in-process store and the session log from disk |
| `format.ts` | The printed line, and `--json` |

`tools/init-scratch.mjs` (`npm run init-scratch`) is a plain Node script, outside the packages; `test/init-scratch.test.ts` runs it in a temp dir.

Tests fake the source (`test/fake.ts`) for the poller, and fake `fetch` for `GitHubSource`. `test/fake-claude.mjs` stands in for `claude`: it emits stream-json and, in `comment`, `ask`, `open` and `permission` modes, calls the MCP tool.

## The marketing page

`packages/web/public/index.html` is the whole site: the billboard, its picture and its script in one file, with `wordmark.svg` beside it. There is no build and no dependencies. `packages/web/public/bots.html` is the `/bots` page (what goes in a `.loopway/<bot>.md` file, from the README and `bots.ts`; static, in the home page's style), and the get-started frame links to it. `packages/web/vercel.json` serves `public/` with `cleanUrls`, so `/bots` is `bots.html`, and `scripts/should-build.mjs` (the `ignoreCommand`) skips deploys when nothing in `packages/web` changed. Only `main` deploys: preview deployments are turned off in the Vercel project's settings, so pull requests get no Vercel deployment, check or comment. Verifications for each PR live in `verifications/`.

The billboard fills the window, and the page is five frames that scrolling steps through. Frame 1 is the sign as painted (the large wordmark and the tagline, and `scroll ↓` at the bottom middle of the face, which steps to the next frame); frames 2 to 5 replace the sign's face with the small wordmark and the description, install and setup, how to get started, and the GitHub link with a small tracker. The words are painted on the canvas like the wordmark, so the lamps and the night light them. Copy and the two links are painted too: `drawFaceContent` leaves a rectangle in `HITS` for each, and a click on the canvas looks there first. The same words are in the page for screen readers (`#words`). Wheel, swipe, arrow, PageUp/PageDown and space keys step one frame; a light scroll steps, and one trackpad flick is one frame however long it coasts (wheel movement adds up to a small amount, and is ready again after a pause, a turn round, or a new flick). The whole picture is always in view, so on a narrow window the words are small. Copy and the links answer to a click, not a press, so a phone counts a tap and a swipe does not press them.

The install host is the one `loopway.craftmill.dev` in the script (`INSTALL_HOST`); change it there if the site moves. What has been found is kept in `localStorage` (`loopway.found`: `snake`, `bird`, `hummingbird`, `moth`, `moose`, `squirrel`, `blackbird`, `skunk`, `trout`, `eagle`, `deadfish`, `loops`) and shown on the last frame as two rows of boxes. The top row is what has to be found by clicking; the bottom row (squirrel, blackbird, skunk, trout) is ticked the first time each is on the picture, and sends nothing. No box can be ticked there; the moose's is the one box that can be unticked. The hummingbird comes only if the morning glory out to the right of the left post is clicked while it is freshly open (from half open until five seconds after it is fully open). The moth comes only if the moonflower on the right of the right post, two up from the ground, is clicked while it is open and all three people are in their chairs at the fire; the one in the red chair swats at it. The moose comes only if the bunch of cattails below the tent is clicked in the first half of the day or of the night (from just before sunrise until midday, or from just before sunset until midnight); it eats the bunch and walks on out under the bottom of the picture, and the bunch stays gone (on later visits too) until the moose's box is unticked, and then it can come again. The eagle comes out of the birch at the left if that birch is clicked as a trout is about to jump: within half a second of the perfect moment (the one that puts the eagle over the trout at the top of its jump) it takes the trout, which then makes no splash; up to a second either side of that it flies out and misses; any other time it stays put. Flying at all ticks `eagle`; the catch ticks `deadfish`, a box that is not shown until it is earned. PostHog gets `frame_viewed` (`frame`, `name`, `from`), `snake_found`, `bird_found`, `hummingbird_found`, `moth_found`, `eagle_found`, `deadfish_found` and `moose_found` (the first time only, and for the moose once more each time its box has been unticked), `moose_unchecked` when its box is unticked, `install_copied` and `github_clicked`, plus the page view, for a funnel. `?u=` and `?speed=` on the page still freeze and speed up the day.
