# loopway verification map

The maintained list of what a user can do in loopway 1.0, and how to prove each thing. Read this, then follow the matching file. A proof that drives one convenient entry point is incomplete when the file lists others.

## Baseline

- `RUN="$(.claude/skills/verify-loopway/scripts/up.sh)"`, then `doctor.sh "$RUN"` all `ok`.
- `V=.claude/skills/verify-loopway/scripts`, and `. "$RUN/state.env"` for `URL` and `CRON_SECRET`.
- Unless a file says otherwise, start signed in: `"$V/sign-in.sh" "$RUN" ada@example.com ada-verify`.
- `HOOK` is the inbox URL: `"$V/lw.sh" "$RUN" inbox --json` gives it as `url`.
- Never drive an instance this run didn't start.

## Features

| Feature | File | Entry point |
| --- | --- | --- |
| Accounts: sign up, log in, username | [accounts.md](accounts.md) | `loopway login`, `whoami`, `username` |
| The inbox and its sources | [sources.md](sources.md) | `loopway inbox`, `loopway source ...` |
| Webhook delivery: accept, dedupe, refuse | [webhook-delivery.md](webhook-delivery.md) | signed `POST /api/webhooks/:userId` |
| Read and poll | [read-and-poll.md](read-and-poll.md) | `loopway read`, `loopway poll` |
| Push | [push.md](push.md) | `loopway push`, `POST /api/messages` |
| Looking at messages | [messages.md](messages.md) | `loopway messages ...` |
| Tokens | [tokens.md](tokens.md) | `loopway token ...` |
| MCP | [mcp.md](mcp.md) | `POST /api/mcp` |
| Schedule and purge | [schedule-and-purge.md](schedule-and-purge.md) | `GET /api/cron/tick` |
| CLI version floor | [version-floor.md](version-floor.md) | any `/api` request |

## Reporting

- Keep the command, stdout, stderr and exit code in `$RUN/evidence/<feature>/`.
- For a mutation, keep a second read that shows it stored.
- If a journey can't be run, report the command you tried and the unmet precondition. Never weaken a journey to pass. Put the reason in that file's `Gotchas`.
