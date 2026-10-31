#!/usr/bin/env bash
# Builds Ditto.app and its DMG (macOS, Xcode command line tools, Node 22).
#
#   scripts/build-app.sh [arm64|x86_64] [version]
#
# Output: build/app-<arch>/Ditto.app and dist/Ditto-mac-<arm64|x64>.dmg.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
arch="${1:-arm64}"
version="${2:-0.0.0}"
version="${version#v}"
case "$arch" in
  arm64) suffix=arm64 ;;
  x86_64) suffix=x64 ;;
  *) echo "usage: scripts/build-app.sh arm64|x86_64 [version]" >&2; exit 2 ;;
esac
out="$root/build/app-$arch"
app="$out/Ditto.app"
contents="$app/Contents"
rm -rf "$out"
mkdir -p "$contents/MacOS" "$contents/Resources" "$contents/Helpers/ditto-runtime"

echo "==> Agent pages"
[[ -d "$root/agent/node_modules" ]] || (cd "$root/agent" && npm ci --silent)
node "$root/web/build.mjs" webkit "$contents/Resources/web"

echo "==> App ($arch)"
swift build -c release --package-path "$root/app" --arch "$arch"
bin="$(swift build -c release --package-path "$root/app" --arch "$arch" --show-bin-path)"
cp "$bin/Ditto" "$contents/MacOS/Ditto"
cp "$root/app/Resources/shield.js" "$root/app/Resources/youtube-skip.js" \
   "$root/app/Resources/ad-rules.json" "$contents/Resources/"
cp "$root/branding/Ditto.icns" "$contents/Resources/Ditto.icns"
cp "$root/LICENSE" "$contents/Resources/LICENSE"
sed -e "s/@VERSION@/$version/" -e "s/@BUILD@/$(date +%Y%m%d%H%M)/" \
  "$root/app/Resources/Info.plist" > "$contents/Info.plist"

echo "==> Model runtime"
# shellcheck source=runtime.env
source "$root/scripts/runtime.env"
if [[ "$arch" == arm64 ]]; then url=$LLAMA_ARM64_URL sha=$LLAMA_ARM64_SHA256
else url=$LLAMA_X64_URL sha=$LLAMA_X64_SHA256; fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fL --retry 4 --retry-delay 2 -o "$work/llama.tar.gz" "$url"
echo "$sha  $work/llama.tar.gz" | shasum -a 256 -c -
tar -xzf "$work/llama.tar.gz" -C "$work"
cp -a "$work"/llama-*/llama-server "$work"/llama-*/*.dylib "$contents/Helpers/ditto-runtime/"
cp "$work"/llama-*/LICENSE "$contents/Resources/LICENSE-llama.cpp"

echo "==> Signing (ad hoc)"
for code in "$contents/Helpers/ditto-runtime"/*; do
  codesign --force --sign - "$code"
done
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"

echo "==> DMG"
mkdir -p "$root/dist"
dmg="$root/dist/Ditto-mac-$suffix.dmg"
staging="$work/dmg"
mkdir -p "$staging"
cp -R "$app" "$staging/"
ln -s /Applications "$staging/Applications"
rm -f "$dmg"
hdiutil create -volname Ditto -srcfolder "$staging" -fs APFS -format ULFO "$dmg" >/dev/null
shasum -a 256 "$dmg" | tee "$dmg.sha256"
echo "Built $app and $dmg"
