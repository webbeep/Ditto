#!/usr/bin/env bash
# Applies chromium/patches/*.patch to the checkout. Safe to re-run: patches
# that are already applied are skipped.
source "$(dirname "$0")/common.sh"

cd "$SRC_DIR"
for patch in "$DITTO_ROOT"/chromium/patches/*.patch; do
  name="$(basename "$patch")"
  if git apply --check --reverse "$patch" 2>/dev/null; then
    log "Already applied: $name"
  elif git apply --check "$patch" 2>/dev/null; then
    log "Applying $name"
    git apply "$patch"
  else
    die "$name does not apply to Chromium $CHROMIUM_VERSION. Rebase it (see docs/CHROMIUM_UPGRADES.md)."
  fi
done
