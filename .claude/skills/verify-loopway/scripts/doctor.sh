#!/usr/bin/env bash
# Read-only: is this run's instance worth driving? Usage: doctor.sh <run-dir>
set -uo pipefail

RUN="${1:?usage: doctor.sh <run-dir>}"
[ -f "$RUN/state.env" ] || { echo "FAIL no state.env in $RUN (cleaned up, or never started)"; exit 1; }
# shellcheck disable=SC1091
. "$RUN/state.env"

bad=0
check() { # check <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok   $label"; else echo "FAIL $label"; bad=1; fi
}
pid_is_server() { ps -o command= -p "$PID" | grep -q 'scripts/dev.ts'; }
port_is_ours() { [ "$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN | head -1)" = "$PID" ]; }
db_is_throwaway() { case "$DB" in loopway_verify_*) return 0 ;; *) return 1 ;; esac; }
health() { curl -fs "$URL/api/health" | grep -q '"ok":true'; }
migrated() {
  [ "$(docker exec loopway-postgres-1 psql -tA -U postgres -d "$DB" \
    -c "SELECT count(*) FROM loopway.schema_migrations WHERE version = '040_v1'")" = "1" ]
}
on_v2() { [ "$(git -C "$ROOT" rev-parse --short HEAD)" = "$COMMIT" ]; }

check "process $PID is scripts/dev.ts" pid_is_server
check "port $PORT is owned by $PID" port_is_ours
check "database $DB is a throwaway" db_is_throwaway
check "GET $URL/api/health" health
check "migration 040_v1 applied to $DB" migrated
check "checkout still at $COMMIT" on_v2
exit "$bad"
