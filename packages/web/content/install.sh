#!/bin/sh
# Installs the loopway CLI from a GitHub release:  curl -fsSL https://loopway.craftmill.dev/install.sh | sh
# LOOPWAY_VERSION=0.3.0 installs that release instead of the latest.
# The release lists its own tarballs in manifest.txt, so this script doesn't change when the package list does.
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

if [ -n "${LOOPWAY_DOWNLOAD_URL:-}" ]; then
  URL="$LOOPWAY_DOWNLOAD_URL" # for CI: a directory of release assets
elif [ -n "${LOOPWAY_VERSION:-}" ]; then
  URL="$BASE/download/cli-v${LOOPWAY_VERSION#v}"
else
  URL="$BASE/latest/download"
fi

DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT

# manifest.txt lists the release's tarballs, one file name per line. Releases before 0.3.0 have none
# and can't be installed with this script.
curl -fsSL "$URL/manifest.txt" -o "$DIR/manifest.txt" || fail "could not download $URL/manifest.txt (releases before 0.3.0 have none)."
FILES=$(cat "$DIR/manifest.txt")
[ -n "$FILES" ] || fail "the release lists no packages."

PACKAGES=""
for file in $FILES; do
  case "$file" in
    */*) fail "unexpected file in the release manifest: $file" ;;
    loopway-*.tgz) ;;
    *) fail "unexpected file in the release manifest: $file" ;;
  esac
  curl -fsSL "$URL/$file" -o "$DIR/$file" || fail "could not download $URL/$file"
  PACKAGES="$PACKAGES $DIR/$file"
done

# shellcheck disable=SC2086
npm install -g $PACKAGES || fail "npm install failed."

# npm can exit 0 without linking the command (seen replacing an `npm link` of the repo), so check it's there and run
# that file, not whichever loopway is first on PATH.
BIN_DIR="$(npm prefix -g)/bin"
BIN="$BIN_DIR/loopway"
[ -x "$BIN" ] || fail "npm installed the packages but didn't create $BIN. Run: npm rebuild -g @loopway/cli"
VERSION=$("$BIN" --version) || fail "$BIN --version failed."

FOUND=$(command -v loopway || true)
if [ -z "$FOUND" ]; then
  echo "loopway install: warning: $BIN_DIR isn't on your PATH, so the loopway command won't be found. Add it to PATH." >&2
elif [ "$FOUND" != "$BIN" ] && ! [ "$FOUND" -ef "$BIN" ]; then
  echo "loopway install: warning: the loopway on your PATH is $FOUND, not the $BIN just installed. Remove it or put $BIN_DIR earlier on PATH." >&2
fi

echo "Installed loopway $VERSION. Next: loopway login"
