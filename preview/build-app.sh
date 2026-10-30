#!/usr/bin/env bash
# Builds the Ditto preview app and DMG on macOS:
#   preview/build-app.sh arm64|x64
# Output: dist/Ditto-mac-<arch>.dmg (+ .sha256)
#
# Ditto.app = official open-source Chromium + the Ditto agent extension +
# the llama.cpp model runtime + a launcher that wires them together. The full
# build (chromium/, scripts/build.sh) compiles Chromium with Ditto's patches
# instead; it needs a large Mac build machine.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
arch="${1:?usage: build-app.sh arm64|x64}"
# shellcheck source=preview/versions.env
source "$root/preview/versions.env"

case "$arch" in
  arm64) chromium_url=$CHROMIUM_ARM64_URL chromium_sha=$CHROMIUM_ARM64_SHA256
         llama_url=$LLAMA_ARM64_URL llama_sha=$LLAMA_ARM64_SHA256 cc_arch=arm64 ;;
  x64)   chromium_url=$CHROMIUM_X64_URL chromium_sha=$CHROMIUM_X64_SHA256
         llama_url=$LLAMA_X64_URL llama_sha=$LLAMA_X64_SHA256 cc_arch=x86_64 ;;
  *) echo "unknown arch $arch" >&2; exit 1 ;;
esac

work="$root/build/preview-$arch"
dist="$root/dist"
rm -rf "$work"
mkdir -p "$work" "$dist"

fetch() {  # url file sha256
  curl -fL --retry 4 --retry-delay 2 -o "$2" "$1"
  echo "$3  $2" | shasum -a 256 -c -
}

echo "==> Chromium"
fetch "$chromium_url" "$work/chrome-mac.zip" "$chromium_sha"
ditto -x -k "$work/chrome-mac.zip" "$work"
app="$work/Ditto.app"
mv "$work/chrome-mac/Chromium.app" "$app"
contents="$app/Contents"
chromium_version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$contents/Info.plist")

echo "==> Model runtime"
fetch "$llama_url" "$work/llama.tar.gz" "$llama_sha"
tar -xzf "$work/llama.tar.gz" -C "$work"
runtime="$contents/Helpers/ditto-runtime"
mkdir -p "$runtime"
cp -a "$work"/llama-*/llama-server "$work"/llama-*/*.dylib "$work"/llama-*/LICENSE "$runtime/"

echo "==> Agent extension, native host, preset"
resources="$contents/Resources/ditto"
mkdir -p "$resources/runtime"
"$root/preview/build-extension.sh" "$resources/extension"
cp "$root/preview/runtime-host.sh" "$resources/"
chmod +x "$resources/runtime-host.sh"
node --input-type=module -e "
  import {routerPresetIni} from '$root/agent/dist/src/models/catalog.js';
  process.stdout.write(routerPresetIni());" > "$resources/runtime/preset.ini"

echo "==> Launcher"
clang -arch "$cc_arch" -mmacosx-version-min=13.0 -O2 -Wall -Wextra -Werror \
  -o "$contents/MacOS/Ditto" "$root/preview/launcher.c"

echo "==> Info.plist"
plist="$contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$plist"; }
pb "Set :CFBundleExecutable Ditto"
pb "Set :CFBundleName Ditto"
pb "Delete :CFBundleDisplayName" 2>/dev/null || true
pb "Add :CFBundleDisplayName string Ditto"
pb "Set :CFBundleIdentifier app.ditto.browser"
# Own profile directory: ~/Library/Application Support/Ditto.
pb "Delete :CrProductDirName" 2>/dev/null || true
pb "Add :CrProductDirName string Ditto"

echo "==> Signing (ad hoc)"
# Inside out: nested code first, then the bundle.
find "$runtime" -type f \( -name '*.dylib' -o -name llama-server \) -exec codesign --force --sign - {} \;
codesign --force --sign - "$contents/MacOS/Ditto"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

echo "==> DMG"
dmg="$dist/Ditto-mac-$arch.dmg"
staging="$work/dmg"
mkdir -p "$staging"
cp -R "$app" "$staging/"
ln -s /Applications "$staging/Applications"
rm -f "$dmg"
hdiutil create -volname Ditto -srcfolder "$staging" -ov -format UDZO "$dmg"
(cd "$dist" && shasum -a 256 "$(basename "$dmg")" > "$(basename "$dmg").sha256")
echo "Chromium $chromium_version" > "$dist/chromium-version-$arch.txt"
echo "Built $dmg (Chromium $chromium_version)"
