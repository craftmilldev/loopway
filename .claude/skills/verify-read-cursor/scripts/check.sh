#!/usr/bin/env bash
# The whole check: the model, then the real store on real Postgres, then whether the covered code moved.
# Usage: check.sh [--trace <case>] [--messages n] [--time n] [--crashes n]
set -uo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SKILL="$ROOT/.claude/skills/verify-read-cursor"
cd "$ROOT"

"$SKILL/scripts/model.sh" "$@"
model=$?
[ "$#" -gt 0 ] && exit "$model" # a trace or a wider run is about the model alone

if ! nc -z localhost 54329 2>/dev/null; then npm run db:up >/dev/null; fi
npx vitest run --config "$SKILL/conformance/vitest.config.ts" --reporter=dot
real=$?

# The reader's half of the promise is the CLI's: spec/cursor.tla's CallHandler, HandlerResolves and CursorWritten.
(cd "$ROOT/packages/cli" && npx vitest run test/cli.test.ts -t 'read and poll' --reporter=dot)
cli=$?

sync="$(sed -n 's/^Sync commit: `\([0-9a-f]*\)`.*/\1/p' "$SKILL/SKILL.md")"
files="$(sed -n 's/^- `\(packages\/[^`]*\)`.*/\1/p;s/^- `\(docs\/[^`]*\)`.*/\1/p' "$SKILL/SKILL.md")"
echo
if ! git cat-file -e "$sync^{commit}" 2>/dev/null; then
  echo "sync commit $sync isn't in this repo (rebased?): check the coverage by hand and update it"
elif [ -n "$(git diff --name-only "$sync" -- $files)" ]; then
  echo "covered code changed since $sync. Re-read it against the model:"
  git diff --stat "$sync" -- $files
else
  echo "covered code unchanged since $sync"
fi

[ "$model" -eq 0 ] && [ "$real" -eq 0 ] && [ "$cli" -eq 0 ] && echo "PASS" && exit 0
echo "FAIL (model exit $model, conformance exit $real, cli exit $cli)"
exit 1
