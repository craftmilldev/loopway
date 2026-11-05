#!/usr/bin/env bash
# Posts a GitHub-signed webhook the way GitHub does, and prints the status and body.
# Usage: post-github.sh <run-dir> <webhook-url> <secret> <delivery-id> [event] [body]
set -euo pipefail

RUN="${1:?usage: post-github.sh <run-dir> <webhook-url> <secret> <delivery-id> [event] [body]}"
HOOK="${2:?webhook url}"; SECRET="${3:?secret}"; DELIVERY="${4:?delivery id}"
EVENT="${5:-pull_request}"
DEFAULT_BODY='{"action":"opened","number":7,"pull_request":{"number":7,"title":"verify"},"repository":{"full_name":"craftmilldev/verify"}}'
BODY="${6:-$DEFAULT_BODY}"
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)"
curl -s -o /dev/stdout -w '\nHTTP %{http_code}\n' -X POST "$HOOK" \
  -H 'content-type: application/json' -H "x-github-event: $EVENT" -H "x-github-delivery: $DELIVERY" \
  -H "x-hub-signature-256: sha256=$SIG" --data-binary "$BODY"
