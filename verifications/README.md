# Verifications

One file per pull request, `<pr>.md`, written by the dev bot after it runs the issue's **How to test it** live in
`craftmilldev/loopway-sandbox` (see `AGENTS.md`). The review bot checks it against this shape.

## Shape

```
# Verification for PR <pr>: <title>
When, where and with what: date, the built CLI from this branch, real `claude` and model, the sandbox, the bot token.

**Bottom line:** which steps passed live, and what differed from the issue.

## Automated
Table of build, test, typecheck, lint, format:check with the test counts; what the new tests cover.

## Live, in craftmilldev/loopway-sandbox
Each step of How to test it, with the issue or PR number, real (trimmed) log lines, and what GitHub showed.

## What I did not check, and what else happened
Every step not run live and why, refused commands, other loopways' noise, and the cleanup
(`npm run sandbox -- list <pr>` showing nothing open).
```

Screenshots go in `verifications/<pr>/`.

## Tools

- `npm run init-scratch -- --reset`: a scratch project with dev and review bots on the sandbox, and no threads.
- `npm run sandbox -- open <pr> "<title>"`, `list <pr>`, `close <pr>`: the issues and PRs a run opens, always tagged
  `[#<pr>]`, and never anything else in the shared sandbox. Use this instead of the bot's `create_issue` (refused for
  the sandbox) or a bare `gh issue create` (refused by the permission check).
- Stop a background `loopway` with `kill -INT <pid>`, never `pkill`.

## Improvement passes

Each pass reads the verifications not yet covered, finds what keeps going wrong, and changes the bots in `.loopway/`
and the tooling. Start the next pass after the last file listed here.

### Pass 1 (#555): 483 to 554

Covered: 483, 488, 493, 494, 500, 502, 504, 510, 511, 512, 514, 525, 529, 532, 533, 535, 536, 541, 544, 545, 547, 548,
553, 554 (every file there was on 2026-11-16).

What recurred, and what changed:

- **Could not open a sandbox issue** (532, 533, 535, 541, 553, 554; 502 had one close refused): `create_issue` is
  refused for the sandbox and `gh issue create` by the permission check, so the live steps were skipped. Fix:
  `npm run sandbox`, with an `allow` rule for it in `.loopway/dev.md` (the review bot ran it without one).
- **Other loopways' threads mixed with mine** (511, 512): `sandbox list` and `close` match the `[#<pr>]` tag only.
- **`pkill` refused** (512, 553): the prompt says to use `kill -INT <pid>`. It is deliberately not in `allow` (it
  could signal any of Matthew's processes), so a refused stop makes the dev bot `ask` Matthew to stop that pid. A
  scoped `npm run scratch -- start|stop` that only signals the pid it started is the next step, as its own issue.
- **The not-checked section had four different headings** and often no cleanup line: one shape, above.
- **Left for later:** browser checks (525, 529, 548) were done by hand with headless Chrome and never on a phone or
  Safari; there is no shared script for them. The `create_issue`/`create_pr` flow of the bot itself can still only be
  checked in tests from the dev bot.
