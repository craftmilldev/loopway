#!/usr/bin/env bash
# Starts one isolated loopway v2 server: its own database, port, secrets and CLI HOME. Prints the run dir.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
BASE="${LOOPWAY_VERIFY_HOME:-$HOME/.cache/loopway-verify}"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
RUN="$BASE/$RUN_ID"
DB="loopway_verify_$(openssl rand -hex 4)"
ADMIN_PORT=54329

[ -d "$ROOT/node_modules" ] || { echo "no node_modules in $ROOT: run npm install" >&2; exit 1; }
mkdir -p "$RUN/home" "$RUN/evidence"

# The Postgres is shared by every checkout. Never stop it, and never use its `loopway` database: starting this branch's
# server runs migration 040_v1, which drops inboxes, messages, bots and orgs.
if ! nc -z localhost "$ADMIN_PORT" 2>/dev/null; then
  (cd "$ROOT" && npm run db:up >/dev/null)
fi
docker exec loopway-postgres-1 psql -q -U postgres -d postgres -c "CREATE DATABASE $DB" >/dev/null

PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
CRON_SECRET="$(openssl rand -hex 32)"

cat >"$RUN/state.env" <<STATE
RUN=$RUN
ROOT=$ROOT
DB=$DB
PORT=$PORT
URL=http://localhost:$PORT
CRON_SECRET=$CRON_SECRET
COMMIT=$(git -C "$ROOT" rev-parse --short HEAD)
STATE

# Every variable that could reach something real is set here, empty: a .env never overrides what the environment has.
cd "$ROOT/packages/web"
env DATABASE_URL="postgres://postgres:postgres@localhost:$ADMIN_PORT/$DB" DATABASE_URL_POOLED= \
  POSTGRES_URL= POSTGRES_URL_NON_POOLING= \
  PORT="$PORT" PUBLIC_BASE_URL= \
  TOKEN_SECRET="$(openssl rand -hex 32)" INBOX_SECRET_KEY="$(openssl rand -base64 32)" CRON_SECRET="$CRON_SECRET" \
  RESEND_API_KEY= EMAIL_FROM= POSTHOG_API_KEY= POSTHOG_HOST= SCHEDULE_OPTIONS=hour,day,week SIGNUPS= MIN_CLI_VERSION= \
  nohup node --import tsx scripts/dev.ts >"$RUN/server.log" 2>&1 &
echo "PID=$!" >>"$RUN/state.env"

# Ready means migrated and answering through the database, not just listening.
for _ in $(seq 1 120); do
  if curl -fs "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo "$RUN"
    exit 0
  fi
  sleep 0.5
done
echo "server didn't become ready; see $RUN/server.log" >&2
tail -20 "$RUN/server.log" >&2
exit 1
