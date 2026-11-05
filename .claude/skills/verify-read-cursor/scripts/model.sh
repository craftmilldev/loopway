#!/usr/bin/env bash
# Runs TLC on every case in spec/cases.txt, once per rule, and compares each result with what the case records.
# Usage: model.sh [--trace <case>] [--messages n] [--time n] [--crashes n]
set -uo pipefail

SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TLA_VERSION=1.8.0
TLA_SHA256=e20447644bfabd29d6bd0fc2c0eb1473fb301c1a0e4dfe1961938ce5a191edbf
CACHE="${LOOPWAY_TLA_CACHE:-$HOME/.cache/loopway-tla}"
JAR="$CACHE/tla2tools-$TLA_VERSION.jar"
RULES="NoSkip NoNeedlessRepeat Delivered"
MAX_JOBS=4

# Delivered is a temporal property, and TLC is far slower on those, so it runs on fewer messages unless asked otherwise.
# Two are enough for what it looks for: the smallest stuck reader is a tie of two.
MESSAGES=3; TIME=7; CRASHES=1; ONLY=""
LIVE_MESSAGES=2; LIVE_TIME=6
while [ "$#" -gt 0 ]; do
  case "$1" in
    --trace) ONLY="$2"; shift 2 ;;
    --messages) MESSAGES="$2"; LIVE_MESSAGES="$2"; shift 2 ;;
    --time) TIME="$2"; LIVE_TIME="$2"; shift 2 ;;
    --crashes) CRASHES="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$JAR" ]; then
  mkdir -p "$CACHE"
  curl -fsSL -o "$JAR.part" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar" \
    && mv "$JAR.part" "$JAR" || { echo "couldn't download TLA+ tools $TLA_VERSION" >&2; exit 2; }
fi
[ "$(shasum -a 256 "$JAR" | cut -d' ' -f1)" = "$TLA_SHA256" ] || { echo "$JAR doesn't match the pinned sha256" >&2; exit 2; }

# macOS's /usr/bin/java is a stub that fails without a JDK, so a java only counts if it runs.
JAVA=""
for candidate in ${JAVA_HOME:+"$JAVA_HOME/bin/java"} /opt/homebrew/opt/openjdk@21/bin/java java; do
  if "$candidate" -version >/dev/null 2>&1; then JAVA="$candidate"; break; fi
done
if [ -z "$JAVA" ] && ! docker info >/dev/null 2>&1; then
  echo "TLC needs Java 11+ or Docker. Install one: brew install openjdk@21" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$SKILL/spec/cursor.tla" "$WORK/"

tlc() { # tlc <run-name>: writes <run-name>.out
  local run="$1"
  if [ -n "$JAVA" ]; then
    (cd "$WORK" && "$JAVA" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers 1 -lncheck final -metadir "$run.states" -config "$run.cfg" cursor.tla) \
      >"$WORK/$run.out" 2>&1
  else
    docker run --rm -v "$CACHE:/tla:ro" -v "$WORK:/work" -w /work eclipse-temurin:21-jre \
      java -XX:+UseParallelGC -cp "/tla/tla2tools-$TLA_VERSION.jar" tlc2.TLC -workers 1 -lncheck final -metadir "$run.states" -config "$run.cfg" cursor.tla \
      >"$WORK/$run.out" 2>&1
  fi
}

outcome() { # outcome <run-name>: holds, breaks or error
  local out="$WORK/$1.out"
  if grep -q 'Model checking completed. No error has been found' "$out"; then echo holds
  elif grep -qE 'Invariant .* is violated|Temporal propert(y|ies) .*violated' "$out"; then echo breaks
  else echo error
  fi
}

CASES="$(grep -v '^#' "$SKILL/spec/cases.txt")"
jobs_running=0
while IFS='|' read -r name page inclusive holdback lag first full _ _; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue
  for rule in $RULES; do
    run="$name-$rule"
    if [ "$rule" = Delivered ]; then
      check="PROPERTY Delivered"; count="$LIVE_MESSAGES"; clock="$LIVE_TIME"
    else
      check="INVARIANT $rule"; count="$MESSAGES"; clock="$TIME"
    fi
    cat >"$WORK/$run.cfg" <<CFG
CONSTANTS
  MessageCount = $count
  MaxTime = $clock
  MaxCrashes = $CRASHES
  Page = $page
  Inclusive = $inclusive
  HoldBack = $holdback
  MaxCommitLag = $lag
  CursorFirst = $first
  MoveOnFullPage = $full
SPECIFICATION Spec
$check
CHECK_DEADLOCK FALSE
CFG
    tlc "$run" &
    jobs_running=$((jobs_running + 1))
    if [ "$jobs_running" -ge "$MAX_JOBS" ]; then wait; jobs_running=0; fi
  done
done <<<"$CASES"
wait

wrong=0
while IFS='|' read -r name _ _ _ _ _ _ breaks says; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue
  broke=""
  matches=1
  for rule in $RULES; do
    result="$(outcome "$name-$rule")"
    [ "$result" = breaks ] && broke="$broke $rule"
    expected=holds
    case ",$breaks," in *",$rule,"*) expected=breaks ;; esac
    if [ "$result" != "$expected" ]; then matches=0; fi
    if [ "$result" = error ]; then echo "TLC failed on $name, $rule:"; tail -15 "$WORK/$name-$rule.out"; fi
  done
  if [ "$matches" = 1 ]; then verdict="as recorded"; else verdict="UNEXPECTED"; wrong=$((wrong + 1)); fi
  printf '%-12s %-25s breaks:%s\n             %s\n' "$verdict" "$name" "${broke:- nothing}" "$says"
  if [ -n "$ONLY" ] || [ "$matches" = 0 ]; then
    for rule in $RULES; do
      [ "$(outcome "$name-$rule")" = breaks ] || continue
      echo; echo "--- $rule ---"
      sed -n '/is violated\|Temporal propert.*violated/,/^[0-9]* states generated/p' "$WORK/$name-$rule.out"
    done
  fi
done <<<"$CASES"

echo
echo "bounds: $MESSAGES messages to clock $TIME for invariants, $LIVE_MESSAGES to clock $LIVE_TIME for Delivered, $CRASHES crash(es). TLC $TLA_VERSION on ${JAVA:-docker}"
if [ "$wrong" -gt 0 ]; then
  echo "$wrong case(s) differ from spec/cases.txt. Read SKILL.md before changing anything."
  exit 1
fi
