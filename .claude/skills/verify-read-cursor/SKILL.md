---
name: verify-read-cursor
description: Exhaustively checks with TLA+ that a loopway reader never silently misses a message: every order of inserts, commits, reads, reader failures and cursor moves, plus the same promise on the real store and the real CLI. Use when changing how messages are stored or read (insertMessage, readMessages, READ_HOLDBACK_SECONDS, INSERT_TIMEOUT_MS, GET /api/messages, the MCP pull, `loopway read`, `loopway poll`, cursor files, the purge), or when asked if reading can lose or repeat messages.
---

# Verify the read cursor

**The promise.** Delivery is at least once: a reader gets every message, and its cursor never moves past one it hasn't finished with.

**The harm.** A skipped message is silent. Nothing retries it, no error shows, and it's gone after 14 days. A bot just never acts on that webhook.

**Why tests don't reach it.** The bug needs a slow insert to overlap a read in a specific order. A row gets its `received_at` inside the insert, but only becomes readable when it commits, so it can appear behind a reader that has already gone past.

## Run it

```bash
.claude/skills/verify-read-cursor/scripts/check.sh
```

It takes about a minute, and needs the local Postgres, which it starts if it's down. It has four parts:

1. **The model.** `scripts/model.sh` runs TLC on `spec/cursor.tla`, once per case in `spec/cases.txt` and per rule. Every result must match what the case records.
2. **Conformance.** `conformance/read-cursor.test.ts` runs the real `insertMessage` and `readMessages` on real Postgres.
3. **The CLI.** The `read and poll` tests in `packages/cli/test/cli.test.ts` hold the reader's half of the promise, in `drain`.
4. **Coverage.** It says whether the code listed below moved since the sync commit.

`PASS` means the results match this file.

**Tools.** TLC needs Java 11 or later: `brew install openjdk@21`, which `model.sh` finds without it being on the `PATH`. Without Java it falls back to the `eclipse-temurin:21-jre` image in Docker, about ten times slower. `model.sh` downloads TLA+ tools 1.8.0 to `~/.cache/loopway-tla` once, and refuses a jar that doesn't match its pinned SHA-256.

To see TLC's shortest path to each break in one case:

```bash
.claude/skills/verify-read-cursor/scripts/check.sh --trace slow-insert
```

Read every result with `/pstack:statechart`. It tells a violation as its shortest path in plain words, and when the check passes it draws how the system moves between states. Give it small constants: it charts up to 500 states.

## The rules

| Rule | In plain words |
| --- | --- |
| `NoSkip` | No stored, unhandled message ends up where a read from the cursor can't reach it. |
| `Delivered` | Every stored message's reader eventually finishes, assuming everything but crashes and new sends keeps happening. |
| `NoNeedlessRepeat` | The reader isn't called again for a message whose cursor write finished. A repeat after a crash is allowed: that's at-least-once. |

## The cases

| Case | What it is | Result |
| --- | --- | --- |
| `built` | the code, page of one | all hold |
| `built-larger-page` | the code, page that holds every message | all hold |
| `slow-insert` | an insert that commits later than the hold-back | breaks `NoSkip`, `Delivered`: **the limit below** |
| `no-holdback` | broken: no hold-back | breaks `NoSkip`, `Delivered` |
| `cursor-first` | broken: the cursor is written before the reader finishes | breaks `NoSkip`, `Delivered` |
| `no-after` | broken: no `after` id, so `>=` on the timestamp alone | breaks `NoNeedlessRepeat`, `Delivered` |
| `head-on-full-page` | broken: the cursor jumps to head with rows left | breaks `NoSkip`, `Delivered` |

The broken variants are how you know each rule can fail. Each is a small change to the code.

### The limit: a commit later than the hold-back is lost

`READ_HOLDBACK_SECONDS` is 5, and `INSERT_TIMEOUT_MS` keeps the `INSERT` under 3 seconds, so a lock wait fails rather than committing late. The conformance test `a lock that outlasts the insert timeout fails the insert, so it can't commit late` shows that working.

The timeout doesn't cover the gap after the statement. `insertMessage` runs in a transaction, so its `COMMIT` is a separate round trip, and neither `statement_timeout` nor `lock_timeout` applies between the two. If the server function stalls there for longer than the hold-back:

1. Insert A's row is stamped, and its `INSERT` returns. The `COMMIT` hasn't been sent.
2. Insert B commits. Five seconds later, B is behind the head.
3. A reader reads B, and its cursor moves past A's timestamp.
4. A commits, behind the cursor. No read from that cursor returns it.

The conformance test `LIMIT: a commit that stalls past the hold-back is lost to a reader that passed it` does this on the real `insertMessage`, with a `Db` that delays between `INSERT` and `COMMIT`. It takes a stalled process, a frozen function or a network hang at exactly that moment, so it's rare. The row is still stored, so `loopway read --since` recovers it within 14 days.

## Scope

**Bounds.** Run on every change: 3 messages to a clock of 7 for the invariants, 2 messages to a clock of 6 for `Delivered` (TLC is far slower on temporal properties, and the smallest stuck reader is a tie of two), and 1 crash. A pass covers those bounds. For a wider run on `built`: `check.sh --trace built --messages 4 --time 10 --crashes 2`.

**Assumptions.** These aren't checked, and the result rests on them:

- No row commits later than the hold-back after its stamp. `INSERT_TIMEOUT_MS` enforces that for the statement, not for the commit. See the limit above.
- One clock, moving forward. `received_at` and the head both come from Postgres's `clock_timestamp()`, which can step backward if the host's clock is corrected. The model's clock never does.
- One reader per cursor. A cursor file has no lock, and two `loopway poll` processes on one reader aren't modelled.
- A cursor write is atomic. `writeCursor` writes a temp file and renames it.

**Not covered.** The 14-day cutoff and the purge, a reader away for longer than that, `--since` resets, `type` filters, HTTP retries, and `order=desc`. The MCP `pull_messages` shares `readPage` with the HTTP read, but its callers hold their own cursor, so the CLI half doesn't apply to them.

## How the model maps to the code

| In `spec/cursor.tla` | In the code |
| --- | --- |
| `InsertStarts(m)`, sets `stamp` | `received_at DEFAULT clock_timestamp()`, in `insertMessage`'s `INSERT` |
| `InsertCommits(m)` | the transaction in `insertMessage` commits |
| `MaxCommitLag` | how long after its stamp a row commits. `built` keeps it within the hold-back, and `slow-insert` doesn't |
| `HeadTime` | `head` in `readMessages`: `clock_timestamp()` less the hold-back |
| `Rows`, `Ordered` | `received_at < head`, `(received_at, id) > (since, after)`, `ORDER BY received_at, id` |
| `ReaderReads` | one `readMessages` call: rows, plus `next_since` and `next_after` |
| `HandlerCalled`, `HandlerResolves` | `await reader(...)` in `drain` |
| `CursorWritten` | `run.cursor = { since: m.received_us, after: m.id }` and `writeCursor`, in `drain` |
| `CursorMovesToHead` | the `next` cursor after a page, in `drain`. `cursorRank = 0` is `after: null` |
| `ReaderCrashes` | a throw, or the process dying between `await reader` and `writeCursor` |

## Coverage

Sync commit: `7ed8868`

- `packages/web/src/store.ts`: `insertMessage`, `readMessages`, `READ_HOLDBACK_SECONDS`, `INSERT_TIMEOUT_MS`
- `packages/web/src/api.ts`: `readPage`, `GET /messages`
- `packages/web/src/db/migrations.ts`: `received_at`, `messages_read_idx` in `040_v1`
- `packages/cli/src/commands/read.ts`: `drain`, `prepare`, `writeCursor`
- `docs/api.md`: the read endpoint

`check.sh` reports when any of these moved. Move the sync commit forward only after you've read the change and confirmed the model and this file still describe the code. The file list is read from this section: keep each path as the first thing on its bullet, and don't start other bullets in this file with a `packages/` or `docs/` path.

## When the code changes

**Does it touch this?** Yes if it changes when a message gets its stamp or commits, how a read picks or orders rows, what a cursor is, or when a reader's cursor moves.

**A case came back `UNEXPECTED`, or a conformance test failed.** Work out which of these it is before touching anything:

- **Real bug.** The trace is a path the code can really take. Fix the code. Don't weaken the rule, or the case's `breaks`, to get a pass.
- **Modelling error.** The trace does something the code can't, like reading an uncommitted row. Fix the model, and say what was wrong in the commit.
- **Intended change.** Update `spec/cursor.tla` and `spec/cases.txt` so they describe the new code, then conformance, then the mapping table.

**Closing the limit.** `LIMIT: a commit that stalls past the hold-back...` will fail when it's closed. That's the fix working. Change the test to assert the message arrives or the insert fails, and update the limit section.

**Changing `READ_HOLDBACK_SECONDS` or `INSERT_TIMEOUT_MS`.** The timeout must stay under the hold-back, with room for the commit. The hold-back test reads the constant, so it follows.

**Adding the purge or the 14-day cutoff to the model.** Both remove rows from a read, so `NoSkip` has to say what's expired rather than skipped. Add them when reader downtime matters.

**Adding a case.** Add a line to `spec/cases.txt` with the rules it should break. A new rule needs a broken variant that breaks it, or it hasn't been shown to fail.
