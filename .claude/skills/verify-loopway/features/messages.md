# Looking at messages

A user looks at the newest messages in their inbox. Plain `messages list` isn't reading: there's no cursor and no hold-back, so a message shows at once. With `--since` it goes through the read path instead, oldest first, and has the hold-back.

## Sub-features

- `list` shows the newest first.
- `since` lists from a time, a page at a time, or every page with `--all`.
- `filter` narrows by type, with a trailing `*` as a prefix match.
- `get` shows one message, and `--data` its payload alone.

## How to get to it (user POV)

Run `loopway messages`.

## Driving it with lw.sh

Preconditions: messages from `webhook-delivery.md` or `push.md`.

- **List.** Run `"$V/lw.sh" "$RUN" messages list`. Newest first.
- **Since.** Run `sleep 6`, then `"$V/lw.sh" "$RUN" messages list --since 1h --limit 1 --all --json`. Every message older than the hold-back, each once, oldest first.
- **Filter.** Run `"$V/lw.sh" "$RUN" messages list --type 'com.github.*'`. Only GitHub rows.
- **Get.** Take an id from the list, and run `"$V/lw.sh" "$RUN" messages get <id>`. It shows the fields and the payload.
- **Data.** Run `"$V/lw.sh" "$RUN" messages get <id> --data`. Only the payload as JSON.
- **Newest, over HTTP.** With `T` from `tokens.md`, run `curl -s -H "authorization: Bearer $T" "$URL/api/messages?order=desc&limit=1"`. One row, and the answer is `{data, has_more}`, with no cursor.

## Gotchas

- `order=desc` takes no `since` or `after`, and answers `400` if given them.
