# loopway

loopway runs on your machine and polls the collaboration tools your agents work in. For now that is GitHub: it prints every new issue and pull request by you, your bot or anyone a bot trusts, and every update to the ones it knows, and sorts them into threads, one bot plus the subjects it tracks. No webhooks, no server.

This is 2.0, an alpha. It started as a poller; threads are the second slice, and later ones grow it into a place that runs agents on what it finds. Design and plan: [#486](https://github.com/craftmilldev/loopway/issues/486).

- A **subject** is an issue or a pull request, keyed `owner/repo#N`.
- **Discovery**, every 2 minutes: new issues and pull requests in your repos, authored by you, the bot user or a login a bot lists under `trusted`. An older one, made before loopway was watching, is picked up the first time anyone touches it while it is open (a comment, an assignment, a reopen). An old closed one stays quiet until it is reopened.
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
node ../packages/cli/dist/index.js   # runs `loopway` here (`npm run build` first)
```

To run it from a directory outside the checkout, `npm link -w @loopway/cli` puts `loopway` on your PATH. The plain log (see [The TUI](#the-tui)) is one line per event:

```
2026-11-10 14:02 new    owner/repo#12 issue "Fix the login bug" by mcwhittemore
2026-11-10 14:03 update owner/repo#12 comment by loopway-bot
2026-11-10 14:03 update owner/repo#12 labeled bug by mcwhittemore
```

`loopway --json` prints the same as NDJSON, one object per line. Stop it with Ctrl-C.

The first run starts now: it does not replay history. An issue or pull request from before that stays quiet until something happens to it; then, if it is open, it is reported as new, with only what happened since as updates, and its bots start threads. After that it remembers where it got to, so a restart prints nothing twice and picks up what happened while it was stopped.

## Threads

A **thread** is one bot plus the subjects it tracks. The rules are in each bot's front matter (see below), and they are deterministic:

- A new issue starts a thread for every bot with `on: issue` (the dev bot). A new pull request starts one for every bot with `on: pull_request` (the review bot). A bot only counts for the repos it lists.
- Every update to a subject goes on the **queue** of every open thread holding it. The queue is what the thread's session is handed (see Sessions). The exception is a comment the thread sent itself, which is not queued back to it.
- A thread closes when every subject on it is closed or merged. A subject that reopens while its thread is open stays on it. A subject that reopens after its thread closed starts a **new** thread for that bot. A closed thread never reopens and gets no more updates.
- A pull request loopway already knew, with no thread for a `pull_request` bot, gets one when its next update arrives.
- A subject a thread **creates** (see Sessions) joins that thread, and every bot that wants its kind starts a thread for it, with its creation as the first update: a new issue gets a dev thread, a new pull request a review thread. The creator's own bot is not skipped, so a dev thread that opens an issue makes a second dev thread for it. The thread stays open until every subject on it, the created ones too, is closed. In the TUI the thread view marks the subjects it created, and filtering by one lists every thread holding it.

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

## Sessions

Each open thread with queued updates and no run in flight gets all of them, oldest first, in one run of Claude Code (`claude -p --permission-mode auto --output-format stream-json`) in the directory `loopway` runs in. A new session gets the bot's prompt plus the updates; later batches run with `--resume <session id>`. `--max N` (default 3) caps the runs in flight.

- A delivered batch leaves the queue. A run that fails (an API error, a usage limit, a bad exit, a bad model name) leaves it, marks the session `failed`, and the thread tries again after 5 minutes. A usage limit holds every delivery until it resets.
- The session acts as the bot user (see Credentials). It talks only through loopway's own MCP server, which loopway hosts and passes with `--mcp-config`. Its tools are `comment(subject, body)`, `ask(subject, question)` (see Asks), `create_issue(repo, title, body, subscribe)` and `create_pr(repo, head, base, title, body)` (the session pushes the branch itself first), and `permission`, which Claude Code itself calls. The prompt tells the session to open issues and pull requests only through the create tools. Every message goes through it, so loopway records it on the thread (`sent`). A comment a thread sent is not queued back to that thread, but is queued to every other thread holding the subject. The comment carries a hidden `<!-- loopway:thread=<id> -->` so the poller can tell. `create_issue` and `create_pr` put the same marker in what they open (an issue made with `subscribe: false` has none), and record it in `sent` with the kind `issue` or `pull_request`. The poller is told about the new subject, so discovery never reports it again; one created while loopway was not listening is matched to its thread by the marker in its text.
- The prompt tells the session to comment only when it has something new to say, so bots don't trade acknowledgements on a shared subject. A turn that ends with none logs `turn ended without a message`.
- A thread that has never run gets its first run even with nothing queued, because a new issue is itself the news. Closed threads get no more runs.

To try it against the sandbox repo (needs `gh auth login` and the bot's token in `~/.loopway/config.json`, see Credentials):

```bash
# in a checkout of loopway
npm install && npm run build
mkdir -p scratch/.loopway && cd scratch
cat > .loopway/dev.md <<'EOF'
---
repos: [craftmilldev/loopway-sandbox]
on: issue
model: sonnet
---

Answer the issue in a comment.
EOF
node ../packages/cli/dist/index.js   # leave this running

# in a second terminal
gh issue create -R craftmilldev/loopway-sandbox --title "What's 2+2?" --body "Reply in one comment."
tail -f ~/.loopway/state/*/threads/*.log   # the session, as it runs
# when loopway-bot has answered, reply as yourself (use the issue number from above):
gh issue comment <number> -R craftmilldev/loopway-sandbox --body "Now times 3."
grep -A4 '"session"' ~/.loopway/state/*/threads/*.json   # the same session id, resumed
```

To see a failed run, set `model: nonesuch` in `.loopway/dev.md` and restart `loopway`.

Per thread, the JSON has `session: { id, status: idle | running | blocked | failed, lastRunAt, lastError? }` and `sent: [{ at, subject, kind, url }]`, and `~/.loopway/state/*/threads/<id>.log` is the session log: assistant text, one line per tool call, and loopway's own lines (`-> delivered 3 updates`, `<- comment on owner/repo#12`).

## Asks: blocked sessions ask on the subject

Sessions run with `--permission-mode auto`, so Claude Code's auto mode classifier decides first. Whatever it would still prompt for goes to loopway's `permission` tool (`--permission-prompt-tool`), and loopway decides in this order, with no model involved:

1. A call you already approved for this session passes.
2. The bot's front matter rules: `deny:` then `allow:`, lists of tool patterns in Claude Code's syntax, like `allow: ["Bash(npm test:*)", "Read"]`. `Bash(curl:*)` is every command that starts with `curl`, `Bash(git status)` that command exactly, `Read(src/*)` a glob over the path.
3. Otherwise loopway **asks**: one comment on the thread's main subject (the first one it tracks), by the bot and carrying the thread marker, with the tool and its input and a request for a 👍 to allow or a 👎 to deny. The call is refused for now with a message telling the session it has asked and will be resumed. The session is marked `blocked`, and the ask is recorded on the thread as `asks: [{ id, kind, commentUrl, subject, tool, input, at, answeredAt? }]`. The same call is not asked again while its ask is open.

A session can also ask a question itself: `ask(subject, question)` posts it (marked) and blocks the session until it is answered. The prompt tells the session to use it when it needs someone to decide, or is stuck.

How an ask is answered:

- **A reaction.** After every pass over the known subjects (every 30 s) loopway reads the reactions on its open permission asks. A 👍 or 👎 from your `gh` user, and nobody else, answers. A 👍 resumes the session with `approved: <tool> <input>` and "Retry it.", and the approval is remembered (`session.approved`), so the same call passes next time. A 👎 resumes it with `denied`. If you left both, the 👎 wins. It costs one conditional request per open ask, and a 304 is free.
- **A reply.** A comment from your `gh` user on the question's subject, after the question, answers it. It is queued like any update, and the ask is marked answered.
- Either way the session leaves `blocked` and its next run gets the answer. A blocked session is not run for other updates meanwhile: they wait in the queue.

Open asks live in the thread's JSON, so a restart keeps waiting on them. The log (`loopway`, `--json`) has `asked` and `answered` lines, and the TUI's thread view lists what the thread is waiting on, with links; `blocked` shows as the session status on the main view.

## Bots: `.loopway/`

`loopway` reads the `.loopway/` folder in the directory it runs from. Each bot is one file, `.loopway/<bot>.md`: Markdown with YAML front matter. The front matter is the bot's rules; the Markdown is its prompt, which starts each thread's session. The keys: `repos`; `on: issue`, `on: pull_request` or a list of both, which says which new subjects start a thread for the bot; `model` (like `sonnet`, passed to Claude Code); `harness` (only `claude`, the default); `allow` and `deny`, lists of tool patterns that decide permission asks (see Asks); `trusted` (see Who a bot listens to); and `max_bot_turns` (see The loop guard). Keys loopway does not know are ignored. It polls the union of every bot's repos.

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


### Who a bot listens to

`trusted: [alice, acme/devs]` in a bot file lists GitHub logins and `org/team` slugs. You and the bot user are always trusted; a team is turned into its members when loopway starts, and if a team can't be read (wrong name, or your `gh` token lacks `read:org`) loopway stops with an error instead of running with a shorter list. Left out, the bot trusts only you and the bot user.

- **Who can start work:** a new issue or pull request starts a thread for a bot only when its author is trusted by that bot **and** it is assigned to you. Until then it is known and watched: assigning it to you later (an `assigned` update) starts the thread. Nobody else's machine, and nobody you haven't listed, can start work on yours.
- **Whose words reach the session:** a comment, or a review (with or without text, since an approval steers a session too), from a login the bot doesn't trust is not queued for it. The log says `ignored comment on owner/repo#N by someone, who tN's bot does not trust` (`--json`: an `ignored` line). Closes, labels and CI results carry no text from the person, so they still pass.
- **Subjects a thread creates:** a pull request needs no assignment, since the thread that opened it is already watching, so the review bot's thread starts at once. An issue is only filed unless `create_issue` is called with `assign: true`, which assigns it to you and starts the dev thread. `create_issue` also needs `subscribe`, with no default: `true` makes the creating thread track the issue, so its comments come back to that thread; `false` files it as its own piece of work (spinning it out of this issue) and nothing on it comes back to the creating thread. The session decides which one it means.

### The loop guard

Bots answer each other: a review bot's comment should reach the dev bot, but two threads on one pull request (or two loopways on one repo) can trade comments forever. So a thread counts the bot user's comments and reviews it has been given since a person last wrote. At `max_bot_turns` (a whole number in the bot's front matter, 3 if left out), the next ones are recorded but start no run: the log says `loop guard tN: comment on owner/repo#N by loopway-bot recorded, not run (3 bot turns since a person last wrote)` (`--json`: a `guarded` line), and the TUI shows `loop guard` as the thread's session. A comment or review from a person the bot trusts, on any subject of the thread, starts the count again and the thread runs on it as usual. Closes, labels, CI results and the bot's own comments to itself are not counted. When you and the bot user are the same login there is nothing to tell apart, and the guard is off.

## The TUI

In a terminal, a bare `loopway` opens a full-screen TUI on the same poller. `loopway --no-tui`, `--json`, or output that isn't a terminal (`loopway | cat`) keeps the plain log below.

- **Main view:** the open threads, then those closed in the last 3 days (by their latest message), closed ones dimmed. A row is the bot, thread status, session status (`no session yet` until one has run), pending count, the time of the latest message and the subjects. The poller's latest line shows at the bottom. `↑`/`↓` moves, `Enter` or `→` opens a thread.
- **Thread view:** the subjects it tracks, the session status, the pending updates (when, kind, subject, who), the messages it sent, and the session log (`~/.loopway/state/<slug>/threads/<id>.log`), which follows new output until you scroll up with `PgUp`/`PgDn`/`Home`; `End` follows again. `←` or `Esc` goes back.
- **Chat:** in the thread view of an open thread, `c` opens an input line (the other keys, `q` included, type into it). `Enter` sends the message to the thread's session; it answers in the session log, in plain text and not on GitHub. The session is told it is in a chat block. A message typed while it is working waits for its turn, and the thread's queued updates wait until the chat ends. `Esc` ends the chat: the session is told, and it comments on the ticket with a short overview of the conversation only if it took an action because of it or the ticket was unclear (testing steps, scope, done-when); a chat that was only for understanding posts nothing. Chat is TUI only, and needs sessions (the bot token).
- **Subject filter:** in the thread view, `↑`/`↓` selects a subject and `Enter` returns to the main view filtered to the threads holding it, with the filter in the header. `Esc` clears it.
- **Status line:** under the rows, what the poller is doing: `polling owner/repo · last checked 14:02 · next in 0:24`. `r` polls GitHub right now (discovery and updates), and the line says `refreshing…` until it is done; the timers restart from there. A second `r` while it runs does nothing, and while GitHub has asked loopway to wait, `r` says so and calls nothing.
- `q` or `Ctrl-C` quits and stops the poller.

## Credentials and state

- **GitHub:** loopway uses your `gh` login (`gh auth token`, or `GH_TOKEN`). You are `gh api user`.
- **The bot user:** the `github` block of `~/.loopway/config.json` names it. Its issues and pull requests count as subjects too.
  ```json
  { "github": { "token": "ghp_...", "name": "loopway-bot", "email": "bot@example.com" } }
  ```
  `name` makes its issues and pull requests subjects. Sessions run as this user: `GH_TOKEN` is the token, and the git author and committer are the name and email. Without a token, sessions are off and threads only queue.
- **State:** per project, in `~/.loopway/state/<slug>`, where the slug is the full path of the `.loopway` folder loopway resolved with every character other than letters and digits turned into `-` (the way Claude Code names its project folders). Two projects never see each other's threads, so bot names can repeat. `state.json` is how far discovery has got per repo, and for each known subject the updates already printed. Threads are `threads/<id>.json`, one file each: bot, subjects, status, created and latest-message times, and the queue. Delete the folder to start over from now. Older versions kept state directly in `~/.loopway/threads` and `~/.loopway/state.json`: they are ignored, and you can delete them.

## Developing

[`docs/developing.md`](docs/developing.md) has the layout and how to run the checks. `packages/web` is a static marketing page that Vercel deploys.

## License

loopway is MIT-licensed; see [`LICENSE`](LICENSE).
