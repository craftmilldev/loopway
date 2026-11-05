# CLI version floor

A CLI older than `MIN_CLI_VERSION_FLOOR` (`packages/web/src/cli-version.ts`) gets a `426` and updates itself. Requests that name no CLI, such as webhooks, are never turned away.

## Sub-features

- `current` is this checkout's CLI, which is served.
- `outdated` is an old CLI version, which is refused.
- `no-cli` is a request with no version, which is served.
- `removed` is a command from before 1.0, which says what happened.

## How to get to it (user POV)

A user with an old CLI runs any command, and the CLI updates and runs it again.

## Driving it with curl

- **Outdated.** Run `curl -s -w ' %{http_code}\n' -H 'x-loopway-cli-version: 0.4.7' "$URL/api/health"`. `cli_outdated` and `426`.
- **No CLI.** Run `curl -s -w ' %{http_code}\n' "$URL/api/health"`. `{"ok":true} 200`.
- **Current.** Run `"$V/lw.sh" "$RUN" whoami`. It works, with no update attempted.

- **Removed.** Run `"$V/lw.sh" "$RUN" bots list`. Non-zero exit, and stderr says `` `loopway bots` was removed in 1.0 ``.

## Gotchas

- `lw.sh` sets `LOOPWAY_NO_UPDATE=1`, and a checkout never self-updates anyway, so the update half stays unproven here. `packages/cli/test/update.test.ts` covers it.
