#!/usr/bin/env bash
# Signs a new user in through the real login path, reading the code from this run's server log, as a local user would.
# Usage: sign-in.sh <run-dir> <email> <username>
set -euo pipefail

RUN="${1:?usage: sign-in.sh <run-dir> <email> <username>}"
EMAIL="${2:?email}"
USERNAME="${3:?username}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$HERE/lw.sh" "$RUN" login --email "$EMAIL" >/dev/null 2>&1 || true # stops at "--code is required" once it has asked
CODE=""
for _ in $(seq 1 20); do
  CODE="$(grep -F "[email to $EMAIL]" "$RUN/server.log" | tail -1 | awk '{print $NF}')" || true
  [ -n "$CODE" ] && break
  sleep 0.25
done
[ -n "$CODE" ] || { echo "no login code for $EMAIL in $RUN/server.log" >&2; exit 1; }
"$HERE/lw.sh" "$RUN" login --email "$EMAIL" --code "$CODE" --username "$USERNAME"
