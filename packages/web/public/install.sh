#!/bin/sh
# Installs loopway:  curl -fsSL https://loopway.craftmill.dev/install.sh | sh
# loopway 2.0 isn't on npm and has no releases yet, so this clones the repo, builds it and links the `loopway` command.
# Run it again to update: it moves the clone to the latest main and rebuilds.
#   LOOPWAY_HOME      where the clone goes (default ~/.loopway/src)
#   LOOPWAY_REPO_URL  where to clone from (default https://github.com/craftmilldev/loopway.git; CI points it at a local repo)
# Needs git, Node 22+ and npm. The link uses npm's global prefix, so it may need the same permissions as `npm i -g`.
set -eu

REPO_URL="${LOOPWAY_REPO_URL:-https://github.com/craftmilldev/loopway.git}"
SRC="${LOOPWAY_HOME:-$HOME/.loopway/src}"

fail() {
  echo "loopway install: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required."
command -v node >/dev/null 2>&1 || fail "Node 22 or newer is required (https://nodejs.org)."
command -v npm >/dev/null 2>&1 || fail "npm is required (it comes with Node)."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Node 22 or newer is required, found $(node -v)."

if [ -d "$SRC/.git" ]; then
  echo "Updating $SRC"
  git -C "$SRC" fetch --quiet origin main || fail "could not fetch $REPO_URL."
  git -C "$SRC" checkout --quiet --force -B main FETCH_HEAD || fail "could not update $SRC."
elif [ -e "$SRC" ] && [ -n "$(ls -A "$SRC")" ]; then
  fail "$SRC exists and isn't a loopway clone. Move it, or set LOOPWAY_HOME."
else
  echo "Cloning $REPO_URL into $SRC"
  mkdir -p "$SRC"
  git clone --quiet --depth 1 --branch main "$REPO_URL" "$SRC" || fail "could not clone $REPO_URL."
fi

echo "Building"
(cd "$SRC" && npm install --no-audit --no-fund && npm run build) || fail "the build failed."

# Installing a directory makes npm symlink it into the global prefix, so the command runs the clone's build.
npm install -g --no-audit --no-fund "$SRC/packages/cli" || fail "npm install -g failed."

# npm can exit 0 without linking the command, so check it's where npm puts global commands and run that file, not
# whichever loopway is first on PATH.
PREFIX=$(npm prefix -g) || fail "npm prefix -g failed."
if [ -n "${VOLTA_HOME:-}" ] && [ "$(command -v npm)" = "$VOLTA_HOME/bin/npm" ]; then
  BIN_DIR="$VOLTA_HOME/bin" # Volta installs global packages itself and puts a shim here
else
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      # npm on Windows puts commands in the prefix itself, which it names with a Windows path
      if command -v cygpath >/dev/null 2>&1; then PREFIX=$(cygpath -u "$PREFIX"); fi
      BIN_DIR="$PREFIX"
      ;;
    *) BIN_DIR="$PREFIX/bin" ;;
  esac
fi
BIN="$BIN_DIR/loopway"
[ -x "$BIN" ] || fail "npm installed the package but didn't create $BIN. Run: npm install -g $SRC/packages/cli"

FOUND=$(command -v loopway || true)
if [ -z "$FOUND" ]; then
  echo "loopway install: warning: $BIN_DIR isn't on your PATH, so the loopway command won't be found. Add it to PATH." >&2
elif [ "$FOUND" != "$BIN" ] && ! [ "$FOUND" -ef "$BIN" ]; then
  echo "loopway install: warning: the loopway on your PATH is $FOUND, not the $BIN just installed. Remove it or put $BIN_DIR earlier on PATH." >&2
fi

echo "Installed loopway from $SRC. Next: gh auth login, then make a .loopway/ folder (see the README) and run loopway."
