# Webhook delivery

A sender posts a signed delivery to the inbox URL. A delivery a registered source verifies is stored as a CloudEvent, a redelivery isn't stored twice, and one nothing verifies gets a `401` and isn't stored.

## Sub-features

- `accept` stores a verified delivery.
- `dedupe` answers a redelivery with the same message id.
- `refuse` turns away a delivery no source verifies.
- `ignore` takes a GitHub `ping` without storing it.

## How to get to it (user POV)

Point a sender's webhook at the inbox URL with the source's secret.

## Driving it with post-github.sh

Preconditions: the `gh` source from `sources.md`, and `HOOK` from the baseline.

- **Accept.** Run `"$V/post-github.sh" "$RUN" "$HOOK" verify-secret-0123456789 d-1`. `HTTP 202` and `{"id":"...","duplicate":false}`.
- **Dedupe.** Run the same command again. `HTTP 200`, the same `id`, `"duplicate":true`.
- **Refuse.** Run `"$V/post-github.sh" "$RUN" "$HOOK" wrong-secret-0123456789 d-2`. `HTTP 401` and `{"error":{"code":"unverified",...}}`.
- **Ignore.** Run `"$V/post-github.sh" "$RUN" "$HOOK" verify-secret-0123456789 d-3 ping`. `HTTP 200` and `{"ignored":true,"reason":"ping"}`.
- **Stored once.** Run `"$V/lw.sh" "$RUN" messages list`. One `com.github.pull_request.opened` row, and nothing from `d-2` or `d-3`.
- **The source noticed.** Run `"$V/lw.sh" "$RUN" source show gh`. `last delivery` shows `(ignored:ping)`, the most recent outcome.

## Gotchas

- A delivery's `source` falls back to `https://github.com` when the body has no `repository.url`, and dedupe is on user + source + id.
- `post-github.sh` proves the path with GitHub's signing scheme. The other sources sign differently; each is covered by `packages/web/test/sources/`.
