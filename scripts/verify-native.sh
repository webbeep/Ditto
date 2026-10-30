#!/usr/bin/env bash
# Checks Ditto's native code against the real Chromium tree without building
# the whole browser (hours): applies the patches, runs `gn gen` (which also
# fails on GN args that do not exist) and `gn check`, then compiles only
#  - Ditto's own C++ (chromium/overlay/ditto),
#  - every Chromium source file the patches change,
#  - the agent page and home page (TypeScript, grit resources, Mojo bindings).
#
#   scripts/verify-native.sh [mac-arm64]
source "$(dirname "$0")/common.sh"

config="${1:-mac-arm64}"
out="out/$config"
"$DITTO_ROOT/scripts/build.sh" "$config" --gen-only

cd "$SRC_DIR"
log "gn check (Ditto's sources live in //chrome/browser/ui:ui)"
gn check "$out" //chrome/browser/ui:ui //ditto/*

# Ditto's .cc files (from the list GN compiles), and the Chromium files the
# patches touch (patched headers are compiled through these). Read with
# plain loops: macOS's bash 3.2 has no mapfile.
files=()
while IFS= read -r file; do
  files+=("$file")
done < <({
  grep -o '"//ditto/[^"]*\.cc"' "$SRC_DIR/ditto/browser/sources.gni" | tr -d '"'
  grep -h '^+++ b/' "$DITTO_ROOT"/chromium/patches/*.patch |
    sed 's#^+++ b/#//#' | grep -E '\.(cc|mm)$' | sort -u
})

objects=()
while IFS= read -r object; do
  objects+=("$object")
done < <(gn outputs "$out" "${files[@]}")

log "Compiling ${#files[@]} files (${#objects[@]} objects)"
autoninja -C "$out" "${objects[@]}" \
  ditto/browser:mojo_bindings ditto/browser/resources:resources
log "Native code compiles against Chromium $CHROMIUM_VERSION."
