# Push

A user or program puts a message in their own inbox.

## Sub-features

- `push` stores a message.
- `dedupe` stores a repeat of an `--id` once.
- `http` does the same with `POST /api/messages`.

## How to get to it (user POV)

Run `loopway push build.finished --subject main --data '{"ok":true}'`.

## Driving it with lw.sh

- **Push.** Run `"$V/lw.sh" "$RUN" push build.finished --subject main --id p-1 --data '{"ok":true}' --json`. `"duplicate": false`.
- **Dedupe.** Run the same command again. The same `id`, `"duplicate": true`.
- **Stored once.** Run `"$V/lw.sh" "$RUN" messages list`. One `build.finished` row, with subject `main`.
- **HTTP.** With `T` from `tokens.md`, run `curl -s -w ' %{http_code}\n' -X POST "$URL/api/messages" -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"type":"from.http"}'`. `202`.

## Gotchas

- Pushed messages have source `urn:loopway:push`.
