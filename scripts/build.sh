#!/usr/bin/env bash
# Builds Ditto.
#
#   scripts/build.sh mac-arm64     # Apple silicon (default)
#   scripts/build.sh mac-x64       # Intel Macs
#   scripts/build.sh ios-arm64     # iPhone/iPad (needs Xcode signing setup)
source "$(dirname "$0")/common.sh"

config="${1:-mac-arm64}"
args_file="$DITTO_ROOT/chromium/args/$config.gn"
[[ -f "$args_file" ]] || die "Unknown config $config (see chromium/args/)"

"$DITTO_ROOT/scripts/sync-overlay.sh"
"$DITTO_ROOT/scripts/patch.sh"

out="out/$config"
cd "$SRC_DIR"
mkdir -p "$out"
{
  cat "$DITTO_ROOT/chromium/args/common.gn"
  cat "$args_file"
  [[ -f "$DITTO_ROOT/chromium/args/local.gn" ]] && cat "$DITTO_ROOT/chromium/args/local.gn"
  true
} > "$out/args.gn"

log "gn gen $out"
gn gen "$out" 2>&1 | tee "$out/gn-gen.log"
# gn only warns about args that no longer exist in this Chromium version;
# fail instead of silently building something heavier than intended.
if grep -q "has no effect" "$out/gn-gen.log"; then
  die "Some args in chromium/args/ have no effect in Chromium $CHROMIUM_VERSION (see $out/gn-gen.log)."
fi

case "$config" in
  mac-*)
    autoninja -C "$out" chrome
    arch=arm64; [[ "$config" == mac-x64 ]] && arch=x86_64
    "$DITTO_ROOT/scripts/build-runtime.sh" "$arch"
    ;;
  ios-*)
    autoninja -C "$out" chrome
    ;;
esac
log "Built $SRC_DIR/$out"
