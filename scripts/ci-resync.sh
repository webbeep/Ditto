#!/usr/bin/env bash
# Brings the Chromium tree up to this checkout's Ditto sources and patches,
# then runs `gn gen`. On a tree restored from an earlier build, patches that
# changed or were removed since are undone first, so only what changed is
# rebuilt.
#
#   scripts/ci-resync.sh mac-arm64
source "$(dirname "$0")/common.sh"

config="${1:-mac-arm64}"
applied="$WORK_DIR/applied-patches"
if [[ -d "$applied" ]]; then
  cd "$SRC_DIR"
  # Newest first, so overlapping patches come off in the right order.
  for old in $(ls "$applied"/*.patch | sort -r); do
    new="$DITTO_ROOT/chromium/patches/$(basename "$old")"
    if [[ ! -f "$new" ]] || ! cmp -s "$old" "$new"; then
      log "Undoing $(basename "$old")"
      git apply -R "$old"
    fi
  done
fi
"$DITTO_ROOT/scripts/sync-overlay.sh"
"$DITTO_ROOT/scripts/patch.sh"
rm -rf "$applied"
cp -R "$DITTO_ROOT/chromium/patches" "$applied"
# Drops trimming args this Chromium asserts on (working copy).
"$DITTO_ROOT/scripts/probe-args.sh" "$config"
"$DITTO_ROOT/scripts/build.sh" "$config" --gen-only
