#!/bin/sh
# Installs the loopway CLI from a GitHub release:  curl -fsSL https://loopway.craftmill.dev/install.sh | sh
# LOOPWAY_VERSION=0.2.0 installs that release instead of the latest.
# Needs Node 22+ and npm. Uses npm's global prefix, so it may need the same permissions as `npm i -g`.
set -eu

REPO="craftmilldev/loopway"
BASE="https://github.com/$REPO/releases"

fail() {
  echo "loopway install: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node 22 or newer is required (https://nodejs.org)."
command -v npm >/dev/null 2>&1 || fail "npm is required (it comes with Node)."
command -v curl >/dev/null 2>&1 || fail "curl is required."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Node 22 or newer is required, found $(node -v)."

if [ -n "${LOOPWAY_VERSION:-}" ]; then
  URL="$BASE/download/cli-v${LOOPWAY_VERSION#v}"
else
  URL="$BASE/latest/download"
fi

DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT

# The CLI and the three packages it depends on are release assets, so npm installs them together.
for name in harnesses rules presets cli; do
  curl -fsSL "$URL/loopway-$name.tgz" -o "$DIR/loopway-$name.tgz" || fail "could not download $URL/loopway-$name.tgz"
done

npm install -g "$DIR/loopway-harnesses.tgz" "$DIR/loopway-rules.tgz" "$DIR/loopway-presets.tgz" "$DIR/loopway-cli.tgz" || fail "npm install failed."

echo "Installed loopway $(loopway --version). Next: loopway login"
