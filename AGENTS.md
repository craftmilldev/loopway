# Agent instructions

- A PR that makes the server reject something the current CLI release sends must raise `MIN_CLI_VERSION_FLOOR` (`packages/web/src/cli-version.ts`) in the same PR, to the release that includes the matching CLI change (the next patch version). See "Releasing the CLI" in `docs/developing.md`.
