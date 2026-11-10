# Developing loopway

- **Stack:** TypeScript on Node 22, [vitest](https://vitest.dev), one runtime dependency ([`yaml`](https://eemeli.org/yaml/), for the front matter of bot files).
- **Packages:** npm workspaces: [`packages/cli`](../packages/cli) (the `loopway` command) and [`packages/web`](../packages/web) (one static marketing page, deployed to Vercel).
- **No server, no database.** State is JSON under `~/.loopway/` (`LOOPWAY_HOME` moves it).

## Run it

```bash
npm install
npm run build
mkdir -p scratch/.loopway && cd scratch      # scratch/ is git-ignored
printf -- '---\nrepos: [owner/name]\non: issue\n---\nprompt\n' > .loopway/dev.md
printf -- '---\nrepos: [owner/name]\non: pull_request\n---\nprompt\n' > .loopway/review.md
npm run cli                                  # bare `loopway`, reading ./.loopway
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
| `config.ts`, `state.ts` | `~/.loopway/config.json`'s `github` block, and `state.json` |
| `format.ts` | The printed line, and `--json` |

Tests fake the source (`test/fake.ts`) for the poller, and fake `fetch` for `GitHubSource`.

## The marketing page

`packages/web/public/index.html` is the whole site. `packages/web/vercel.json` serves `public/` with no install or build, and `scripts/should-build.mjs` (the `ignoreCommand`) skips deploys when nothing in `packages/web` changed. Verifications for each PR live in `verifications/`.
