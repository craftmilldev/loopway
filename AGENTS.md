# Agent instructions

- A PR that makes the server reject something the current CLI release sends must raise `MIN_CLI_VERSION_FLOOR` (`packages/web/src/cli-version.ts`) in the same PR, to the release that includes the matching CLI change (the next patch version). See "Releasing the CLI" in `docs/developing.md`.
- Vercel skips the web build when nothing web depends on changed (`packages/web/scripts/should-build.mjs`, run as `ignoreCommand`). It follows `@loopway/*` dependencies from `packages/web/package.json`, plus the root files in `ROOT_INPUTS`. If web ever reads a file outside `packages/web` and the packages it depends on, add that path to `ROOT_INPUTS` in the same PR.
