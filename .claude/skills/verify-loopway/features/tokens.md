# Tokens

A long-lived token for what runs unattended, set as `LOOPWAY_API_KEY`. It's shown once.

## Sub-features

- `create` makes one.
- `list` shows them, without the value.
- `use` authenticates a request.
- `revoke` ends one.

## How to get to it (user POV)

Run `loopway token create poller`.

## Driving it with lw.sh and curl

- **Create.** Run `"$V/lw.sh" "$RUN" token create ci --json`. `token` starts `lw_`. Set `T` to it.
- **Use.** Run `curl -s -H "authorization: Bearer $T" "$URL/api/me"`. It's the signed-in user.
- **List.** Run `"$V/lw.sh" "$RUN" token list`. `ci`, with a `LAST USED` time and no value.
- **Revoke.** Run `"$V/lw.sh" "$RUN" token revoke ci`. `Revoked ci.` The `curl` from **Use** now gets `401`.

## Gotchas

- `lw.sh` blanks `LOOPWAY_API_KEY`, so it always uses the session token. Prove a token with `curl`.
