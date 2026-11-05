#!/usr/bin/env bash
# Stops what up.sh started and removes its scratch state. Evidence stays. Usage: down.sh <run-dir>
set -uo pipefail

RUN="${1:?usage: down.sh <run-dir>}"
[ -f "$RUN/state.env" ] || { echo "nothing to clean in $RUN"; exit 0; }
# shellcheck disable=SC1091
. "$RUN/state.env"

# Only the pid we recorded, and only if it's still our server. Never kill by name: other checkouts run the same script.
if ps -o command= -p "$PID" 2>/dev/null | grep -q 'scripts/dev.ts'; then
  kill "$PID"
  for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
fi

case "$DB" in
  loopway_verify_*) docker exec loopway-postgres-1 psql -q -U postgres -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" ;;
  *) echo "refusing to drop $DB" >&2 ;;
esac

mkdir -p "$RUN/evidence"
[ -f "$RUN/server.log" ] && mv "$RUN/server.log" "$RUN/evidence/server.log"
rm -rf "$RUN/home" "$RUN/state.env"
echo "evidence kept in $RUN/evidence"
