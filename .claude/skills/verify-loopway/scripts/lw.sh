#!/usr/bin/env bash
# Runs the CLI from this checkout against one run's server, with that run's HOME. Usage: lw.sh <run-dir> <args...>
set -euo pipefail

RUN="${1:?usage: lw.sh <run-dir> <loopway args...>}"; shift
# shellcheck disable=SC1091
. "$RUN/state.env"
cd "$ROOT"
exec env VERIFY_EVIDENCE="$RUN/evidence" HOME="$RUN/home" LOOPWAY_API_URL="$URL" LOOPWAY_API_KEY= LOOPWAY_NO_UPDATE=1 POSTHOG_API_KEY= DO_NOT_TRACK=1 \
  node --import tsx packages/cli/src/index.ts "$@"
