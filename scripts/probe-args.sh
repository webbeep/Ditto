#!/usr/bin/env bash
# Tries each "Trimmed features" line of chromium/args/common.gn on its own
# with `gn gen` and keeps only the ones this Chromium accepts (some, like
# enable_screen_ai_service=false, are asserted on by Chromium's own build
# files on macOS). Prints a table, writes the rejected lines to
# $WORK_DIR/rejected-args.txt, and removes them from the working copy of
# common.gn so the following steps build with a supported set.
#
#   scripts/probe-args.sh mac-arm64
source "$(dirname "$0")/common.sh"

config="${1:-mac-arm64}"
common="$DITTO_ROOT/chromium/args/common.gn"
platform="$DITTO_ROOT/chromium/args/$config.gn"
trimmed=$(awk '/^# Trimmed features/{on=1; next} on && /^$/{on=0} on && /=/' "$common")
base=$(awk '/^# Trimmed features/{on=1; next} on && /^$/{on=0} !on' "$common")

cd "$SRC_DIR"
rejected="$WORK_DIR/rejected-args.txt"
: > "$rejected"
out=out/probe
printf '%-45s %s\n' "arg" "gn gen"
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  mkdir -p "$out"
  { echo "$base"; cat "$platform"; echo "$line"; } > "$out/args.gn"
  if result=$(gn gen "$out" 2>&1) && ! grep -q "has no effect" <<<"$result"; then
    printf '%-45s %s\n' "${line%%#*}" "ok"
  else
    printf '%-45s %s\n' "${line%%#*}" "REJECTED: $(grep -m1 -E 'ERROR|has no effect' <<<"$result")"
    echo "$line" >> "$rejected"
  fi
done <<<"$trimmed"
rm -rf "$out"

# Build the rest with the supported set (working copy only).
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  grep -vxF "$line" "$common" > "$common.tmp" && mv "$common.tmp" "$common"
done < "$rejected"
log "$(wc -l < "$rejected" | tr -d ' ') arg(s) rejected; see $rejected"
