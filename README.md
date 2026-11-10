# loopway

loopway runs on your machine and polls the collaboration tools your agents work in. For now that is GitHub: it prints every new issue and pull request by you or your bot, and every update to the ones it knows. No webhooks, no server.

This is 2.0, an alpha. It starts as a poller, and later slices grow it into a place that runs agents on what it finds. Design and plan: [#486](https://github.com/craftmilldev/loopway/issues/486).

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
---

You are the dev bot. You take an issue, make the change and open a pull request.
EOF
npm run cli          # runs `loopway` here
```

To run it from a directory outside the checkout, `npm link -w @loopway/cli` puts `loopway` on your PATH. Output is one line per event:

```
2026-11-10 14:02 new    owner/repo#12 issue "Fix the login bug" by mcwhittemore
2026-11-10 14:03 update owner/repo#12 comment by loopway-bot
2026-11-10 14:03 update owner/repo#12 labeled bug by mcwhittemore
```

`loopway --json` prints the same as NDJSON, one object per line. Stop it with Ctrl-C.

The first run starts now: it does not replay history. After that it remembers where it got to, so a restart prints nothing twice and picks up what happened while it was stopped.

## Bots: `.loopway/`

`loopway` reads the `.loopway/` folder in the directory it runs from. Each bot is one file, `.loopway/<bot>.md`: Markdown with YAML front matter. The front matter is the bot's rules; the Markdown is its prompt, which later slices hand to a session. For now only `repos` matters, and keys loopway does not know are ignored. It polls the union of every bot's repos.

`.loopway/dev.md`:

```markdown
---
repos: [craftmilldev/loopway]
---

You are the dev bot. When an issue is assigned to you, read it, make the change on a branch, run the tests, and open
a pull request that says `Closes #N`. Ask on the issue when something is unclear.
```

`.loopway/review.md`:

```markdown
---
repos: [craftmilldev/loopway]
---

You are the review bot. Read the pull request and its diff, check it against the issue it closes, and leave a
review. Be specific, and say what you ran.
```

## Credentials and state

- **GitHub:** loopway uses your `gh` login (`gh auth token`, or `GH_TOKEN`). You are `gh api user`.
- **The bot user:** the `github` block of `~/.loopway/config.json` names it. Its issues and pull requests count as subjects too.
  ```json
  { "github": { "token": "ghp_...", "name": "loopway-bot", "email": "bot@example.com" } }
  ```
  Only `name` is used so far; `token` and `email` are for later slices.
- **State:** `~/.loopway/state.json`, plain JSON: how far discovery has got per repo, and for each known subject the updates already printed. Set `LOOPWAY_HOME` to keep it somewhere else. Delete it to start over from now.

## Developing

[`docs/developing.md`](docs/developing.md) has the layout and how to run the checks. `packages/web` is a static marketing page that Vercel deploys.

## License

loopway is MIT-licensed; see [`LICENSE`](LICENSE).
