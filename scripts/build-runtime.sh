#!/usr/bin/env bash
# Fetches the model runtime shipped inside Ditto.app: llama.cpp's own macOS
# release build of llama-server (router mode, /v1/systemone for d1, Metal on
# Apple silicon) with its dylibs, pinned and checksummed in
# chromium/runtime.env.
#
#   scripts/build-runtime.sh [arm64|x86_64]
source "$(dirname "$0")/common.sh"
source "$DITTO_ROOT/chromium/runtime.env"

arch="${1:-arm64}"
case "$arch" in
  arm64) url=$LLAMA_ARM64_URL sha=$LLAMA_ARM64_SHA256 ;;
  x86_64) url=$LLAMA_X64_URL sha=$LLAMA_X64_SHA256 ;;
  *) die "Unknown arch $arch" ;;
esac
out="$WORK_DIR/runtime-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

log "Fetching llama.cpp for $arch"
curl -fL --retry 4 --retry-delay 2 -o "$tmp/llama.tar.gz" "$url"
echo "$sha  $tmp/llama.tar.gz" | shasum -a 256 -c -
tar -xzf "$tmp/llama.tar.gz" -C "$tmp"
rm -rf "$out"
mkdir -p "$out"
cp -a "$tmp"/llama-*/llama-server "$tmp"/llama-*/*.dylib "$tmp"/llama-*/LICENSE "$out/"
"$out/llama-server" --version
log "Runtime: $out"
