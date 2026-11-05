---
name: verify-loopway
description: Drive loopway 1.0 the way a user does and prove behaviour on a real server: the `loopway` CLI against a local API, signed webhooks, the hosted MCP server and the daily cron. Use after changing packages/web, packages/cli or packages/sources, or when asked to prove login, sources, webhook delivery, read, poll, push, tokens, MCP or the version floor works. It runs on a throwaway database, so it's safe beside the shared dev Postgres.
---

# Verify loopway

loopway 1.0 is on branch `v2`, unmerged (PR 483): one inbox per user, read from your own code. `CHANGELOG.md` says what changed from 0.x. A new user-facing command or route gets a feature file in `features/` in the same PR.

**The surface.** The primary one is the `loopway` CLI talking to the HTTP API. Senders reach the same server by posting signed webhooks, agents reach it through the MCP server at `/api/mcp`, and Vercel Cron calls `/api/cron/tick`. The only web page left is the marketing landing page at `/`.

**Two things not to do.**

- Never run this branch's server against the `loopway` database, which is what `npm run dev` and `.env.example` point at. Starting the server applies migration `040_v1`, which deletes inboxes, messages, bots and orgs, and that database belongs to every other checkout. `up.sh` makes its own.
- Never run the CLI without `lw.sh`. Plain `npm run cli` uses your real `~/.loopway/config.json`, and so production.

## Launch

```bash
RUN="$(.claude/skills/verify-loopway/scripts/up.sh)"; echo "$RUN"
```

From an empty start, `up.sh` starts the shared Postgres if it's down, creates a `loopway_verify_<hex>` database, picks a free port, generates secrets, starts `packages/web/scripts/dev.ts` without its file watcher restarting it, and waits until `GET /api/health` answers through the database. Migrations run at startup, so a ready server is a migrated one. Nothing needs seeding: `sign-in.sh` makes the user.

Several runs can go side by side. `$RUN` is `~/.cache/loopway-verify/<run-id>` (set `LOOPWAY_VERIFY_HOME` to move it), and `$RUN/state.env` has `URL`, `PORT`, `DB`, `PID`, `CRON_SECRET` and `COMMIT`. Keep `$RUN` for every later command, since the shell may not keep it for you.

## Doctor

Read-only. Run it first, and whenever anything looks off:

```bash
.claude/skills/verify-loopway/scripts/doctor.sh "$RUN"
```

It checks that the process is ours, that it owns the port, that the database is a throwaway, that health answers, that `040_v1` is applied and that the checkout hasn't moved. A `FAIL` on the last check means someone committed or switched branches after launch: `down.sh` and start again.

## Drive

```bash
V=.claude/skills/verify-loopway/scripts
"$V/sign-in.sh" "$RUN" ada@example.com ada-verify   # real login path; the code comes from the server's console
"$V/lw.sh" "$RUN" whoami                            # any loopway command, on this run's server and HOME
"$V/post-github.sh" "$RUN" "$HOOK" "$SECRET" d-1    # a webhook signed the way GitHub signs it
"$V/lw.sh" "$RUN" read "$V/reader.mjs"              # the bundled reader logs to $RUN/evidence/read.log
```

Add `--json` to a CLI read command to get something you can assert on. `features/readme.md` lists every feature and its recipe.

## Evidence

Write proof to `$RUN/evidence/`. It outlives cleanup, and `down.sh` moves the server log in beside it.

- Exercise the real path: the CLI, or a signed `POST` to the webhook URL. Don't insert rows or call the store directly.
- Capture the action and the state after it: the command, its output and exit code, then a second read that shows the result. An HTTP `202` proves acceptance, and `messages list` proves storage.
- Check the side effect, not just the reply. A delivery shows up in `messages list` and in `inbox show`'s `last delivery`.
- A read holds back the newest 5 seconds (`READ_HOLDBACK_SECONDS`). A message pushed now isn't in a read for 5 seconds, so a read straight after a push proving nothing is not a bug. Wait 6 seconds. `messages list` has no hold-back, so it shows a message at once.
- Nothing here reaches a real sender, Vercel, Resend or PostHog: `up.sh` blanks those keys. Whether real senders sign and shape deliveries as these helpers do stays unproven by this skill.

## Cleanup

```bash
.claude/skills/verify-loopway/scripts/down.sh "$RUN"
```

It stops only the recorded server pid, drops only a `loopway_verify_*` database, and removes the throwaway `HOME`. `$RUN/evidence` stays. Run it after failed attempts too. It leaves the shared Postgres running: other checkouts use it, so never run `npm run db:down` from here.

## Helpers

All in `.claude/skills/verify-loopway/scripts/`, all executable:

| Script | Use |
| --- | --- |
| `up.sh` | start an isolated instance; prints `$RUN` |
| `doctor.sh <run>` | is this instance worth driving? |
| `lw.sh <run> <args...>` | run the CLI from this checkout against the instance |
| `sign-in.sh <run> <email> <username>` | sign up or log in through the real path |
| `post-github.sh <run> <url> <secret> <delivery-id> [event] [body]` | post a signed GitHub webhook |
| `reader.mjs` | a reader for `read` and `poll`: logs to `$RUN/evidence/read.log`, and throws on the type in `$RUN/evidence/fail-on` |
| `down.sh <run>` | tear down, keeping the evidence |
