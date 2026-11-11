# loopway

loopway runs on your machine and polls the collaboration tools your agents work in. For now that is GitHub: it prints every new issue and pull request by you or your bot, and every update to the ones it knows, and sorts them into threads, one bot plus the subjects it tracks. No webhooks, no server.

This is 2.0, an alpha. It started as a poller; threads are the second slice, and later ones grow it into a place that runs agents on what it finds. Design and plan: [#486](https://github.com/craftmilldev/loopway/issues/486).

- A **subject** is an issue or a pull request, keyed `owner/repo#N`.
- **Discovery**, every 2 minutes: new issues and pull requests in your repos, authored by you or by the bot user.
- **Updates**, every 30 seconds, for each known subject: comments, reviews, review comments, state changes (closed, merged, reopened), labels, assignees, edits, and CI check runs and statuses on pull requests.
- It backs off when GitHub rate limits it (`x-ratelimit-reset`, `retry-after`).

## Getting started

```bash
npm install && npm run build         # Node 22+
gh auth login                        # loopway acts as whoever gh is logged in as
```

Make a directory to run it from, with a `.loopway/` folder holding one file per bot (`scratch/` inside the checkout is git-ignored):

```bash
mkdir -p scratch/.loopway && cd scratch
cat > .loopway/dev.md <<'EOF'
---
repos: [owner/name]
on: issue
---

You are the dev bot. You take an issue, make the change and open a pull request.
EOF
cat > .loopway/review.md <<'EOF'
---
repos: [owner/name]
on: pull_request
---

You are the review bot. You read a pull request and review it.
EOF
npm run cli          # runs `loopway` here
```

To run it from a directory outside the checkout, `npm link -w @loopway/cli` puts `loopway` on your PATH. The plain log (see [The TUI](#the-tui)) is one line per event:

```
2026-11-10 14:02 new    owner/repo#12 issue "Fix the login bug" by mcwhittemore
2026-11-10 14:03 update owner/repo#12 comment by loopway-bot
2026-11-10 14:03 update owner/repo#12 labeled bug by mcwhittemore
```

`loopway --json` prints the same as NDJSON, one object per line. Stop it with Ctrl-C.

The first run starts now: it does not replay history. After that it remembers where it got to, so a restart prints nothing twice and picks up what happened while it was stopped.

## Threads

A **thread** is one bot plus the subjects it tracks. The rules are in each bot's front matter (see below), and they are deterministic:

- A new issue starts a thread for every bot with `on: issue` (the dev bot). A new pull request starts one for every bot with `on: pull_request` (the review bot). A bot only counts for the repos it lists.
- Every update to a subject goes on the **queue** of every open thread holding it. The queue is what a later slice hands to a session; for now it only fills.
- A thread closes when every subject on it is closed or merged. A subject that reopens while its thread is open stays on it. A subject that reopens after its thread closed starts a **new** thread for that bot. A closed thread never reopens and gets no more updates.
- A pull request loopway already knew, with no thread for a `pull_request` bot, gets one when its next update arrives.

The bare `loopway` adds thread lines to its output, after the line of the event that caused them:

```
2026-11-10 14:02 new    owner/repo#12 issue "Fix it" by you
2026-11-10 14:02 thread opened 3f9a1c2e dev owner/repo#12
2026-11-10 14:05 update owner/repo#12 comment by you
2026-11-10 14:05 queued owner/repo#12 comment -> 3f9a1c2e
2026-11-10 14:30 thread closed 3f9a1c2e
```

`loopway threads` lists the open threads and those closed in the last 3 days (judged by each thread's latest message): id, bot, status, subjects, and how many updates are pending. It reads the files, so run it in another terminal while `loopway` runs. `--json` works on both, one object per line.

```
3f9a1c2e  dev      open   owner/repo#12  2 pending
8c01d7b4  review   closed owner/repo#13  1 pending
```

## Bots: `.loopway/`

`loopway` reads the `.loopway/` folder in the directory it runs from. Each bot is one file, `.loopway/<bot>.md`: Markdown with YAML front matter. The front matter is the bot's rules; the Markdown is its prompt, which later slices hand to a session. Two keys matter so far: `repos`, and `on: issue`, `on: pull_request` or a list of both, which says which new subjects start a thread for the bot. Keys loopway does not know are ignored. It polls the union of every bot's repos.

`.loopway/dev.md`:

```markdown
---
repos: [craftmilldev/loopway]
on: issue
---

You are the dev bot. When an issue is assigned to you, read it, make the change on a branch, run the tests, and open
a pull request that says `Closes #N`. Ask on the issue when something is unclear.
```

`.loopway/review.md`:

```markdown
---
repos: [craftmilldev/loopway]
on: pull_request
---

You are the review bot. Read the pull request and its diff, check it against the issue it closes, and leave a
review. Be specific, and say what you ran.
```

## The TUI

In a terminal, a bare `loopway` opens a full-screen TUI on the same poller. `loopway --no-tui`, `--json`, or output that isn't a terminal (`loopway | cat`) keeps the plain log below.

- **Main view:** the open threads, then those closed in the last 3 days (by their latest message), closed ones dimmed. A row is the bot, thread status, session status (`no session yet` until one has run), pending count, the time of the latest message and the subjects. The poller's latest line shows at the bottom. `↑`/`↓` moves, `Enter` or `→` opens a thread.
- **Thread view:** the subjects it tracks, the session status, the pending updates (when, kind, subject, who), the messages it sent, and the session log (`.loopway/state/threads/<id>.log`), which follows new output until you scroll up with `PgUp`/`PgDn`/`Home`; `End` follows again. `←` or `Esc` goes back.
- **Subject filter:** in the thread view, `↑`/`↓` selects a subject and `Enter` returns to the main view filtered to the threads holding it, with the filter in the header. `Esc` clears it.
- `q` or `Ctrl-C` quits and stops the poller.

## Credentials and state

- **GitHub:** loopway uses your `gh` login (`gh auth token`, or `GH_TOKEN`). You are `gh api user`.
- **The bot user:** the `github` block of `~/.loopway/config.json` names it. Its issues and pull requests count as subjects too.
  ```json
  { "github": { "token": "ghp_...", "name": "loopway-bot", "email": "bot@example.com" } }
  ```
  Only `name` is used so far; `token` and `email` are for later slices.
- **State:** per project, in `.loopway/state/` next to your bot files, which holds its own `.gitignore` of `*` so the bot files can be committed and the state can't. `state.json` is how far discovery has got per repo, and for each known subject the updates already printed. Threads are `threads/<id>.json`, one file each: bot, subjects, status, created and latest-message times, and the queue. Two projects never see each other's threads, so bot names can repeat. Set `LOOPWAY_STATE` to keep it somewhere else. Delete the folder to start over from now. Older versions kept state in `~/.loopway/threads` and `~/.loopway/state.json`: they are ignored, and you can delete them. `~/.loopway/` holds only `config.json`.

## Developing

[`docs/developing.md`](docs/developing.md) has the layout and how to run the checks. `packages/web` is a static marketing page that Vercel deploys.

## License

loopway is MIT-licensed; see [`LICENSE`](LICENSE).
