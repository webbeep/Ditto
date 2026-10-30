#!/usr/bin/env bash
# Fetches Chromium at the pinned version with only what macOS and iOS
# builds need: no git history, no Android/Windows/Linux/Fuchsia/ChromeOS
# toolchains, SDKs or test data.
#
#   scripts/fetch.sh            # macOS
#   scripts/fetch.sh --ios      # macOS + iOS
source "$(dirname "$0")/common.sh"

[[ "$(uname)" == Darwin ]] || die "Chromium for macOS/iOS must be fetched and built on macOS."

target_os='"mac"'
[[ "${1:-}" == --ios ]] && target_os='"mac", "ios"'

mkdir -p "$WORK_DIR"
if [[ ! -x "$DEPOT_TOOLS/gclient" ]]; then
  log "Installing depot_tools"
  git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS"
fi

cat > "$WORK_DIR/.gclient" <<GCLIENT
solutions = [{
  "name": "src",
  "url": "https://chromium.googlesource.com/chromium/src.git",
  "managed": False,
  "custom_deps": {},
  "custom_vars": {
    # Profile-guided optimization data: official builds are ~10% faster with it.
    "checkout_pgo_profiles": True,
    "checkout_js_coverage_modules": False,
    "checkout_telemetry_dependencies": False,
    "checkout_instrumented_libraries": False,
    "checkout_press_benchmarks": False,
    "checkout_gpu_meet_effects": False,
    "checkout_soda": False,
    "checkout_src_internal": False,
  },
}]
target_os = [$target_os]
target_os_only = True
GCLIENT

log "Syncing Chromium $CHROMIUM_VERSION (shallow, macOS/iOS only)"
cd "$WORK_DIR"
gclient sync --nohooks --no-history --shallow -D \
  --revision "src@refs/tags/$CHROMIUM_VERSION"

"$DITTO_ROOT/scripts/prune.sh"

log "Running hooks (toolchains, PGO profiles)"
gclient runhooks
log "Done: $SRC_DIR"
