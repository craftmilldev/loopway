# Read and poll

A reader is a JS file. `loopway read` hands it every message since its last read, one at a time and in order, and exits. `loopway poll` does the same until stopped. The cursor moves past a message only once the reader has finished with it.

## Sub-features

- `first-read` starts from now, and says so.
- `backfill` goes further back with `--since`.
- `resume` delivers nothing it has already delivered.
- `hold-back` leaves the newest 5 seconds for the next read.
- `failure` stops on a throw, and that message comes again.
- `poll` delivers as messages arrive, and stops on `SIGTERM`.
- `filter` reads one type with `--type`, on its own cursor.
- `expired` warns when a cursor is older than the inbox keeps messages.

## How to get to it (user POV)

Write a `reader.js` whose default export takes a message, and run `loopway read reader.js`.

## Driving it with lw.sh and reader.mjs

Preconditions: at least one message, from `"$V/lw.sh" "$RUN" push build.finished --id r-0`. Set `R="$PWD/$V/reader.mjs"` and `LOG="$RUN/evidence/read.log"`, and start with no `read.log`.

- **First read.** Run `"$V/lw.sh" "$RUN" read "$R"`. Stderr has `First read of this reader: starting from now` and `Read 0 messages.` No `read.log`. One file in `"$RUN/home/.loopway/cursors/"`.
- **Backfill.** Run `sleep 6`, then `"$V/lw.sh" "$RUN" read "$R" --since 1h`. `Read 1 message.` `$LOG` has `r-0 build.finished`.
- **Resume.** Run `"$V/lw.sh" "$RUN" read "$R"`. `Read 0 messages.`, and `$LOG` didn't grow.
- **Hold-back.** Run `"$V/lw.sh" "$RUN" push after.read --id r-1`, then read at once. `Read 0 messages.` Run `sleep 6` and read. `Read 1 message.`
- **Failure.** Run `echo fail.me > "$RUN/evidence/fail-on"`, push `fail.me --id r-2` and `after.fail --id r-3`, `sleep 6`, then read. Exit `1`, stderr names `The reader failed on message`, and `$LOG` has neither. Remove `fail-on` and read again. `Read 2 messages.`, in order.
- **Poll.** Run `"$V/lw.sh" "$RUN" poll "$R" --interval 1 >"$RUN/evidence/poll.out" 2>&1 & POLL=$!`, push `polled --id r-4`, `sleep 9`. `$LOG` ends `r-4 polled`. `kill -TERM "$POLL"`, and within a second the process has exited.
- **Filter.** Run `"$V/lw.sh" "$RUN" read "$R" --type 'polled' --since 1h`. It delivers `r-4` again, on a second cursor file.

- **Expired.** Run `"$V/lw.sh" "$RUN" read "$R" --since 20d`. Stderr has `This cursor is older than the inbox keeps messages`, and it still delivers what's held.

## Gotchas

- A read straight after a push gets nothing: the hold-back. Wait 6 seconds.
- A throwing reader makes `read` print a raw stack trace rather than a one-line error. It stops correctly, with exit `1`.
- `--since` moves the cursor, and `2h` or `3d` mean that long ago.
- Losing no message is the `verify-read-cursor` skill's job. This feature proves the path, not the race.
