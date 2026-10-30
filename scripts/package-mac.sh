#!/usr/bin/env bash
# Bundles the runtime into Ditto.app, signs, notarizes (when credentials are
# set) and builds the DMG.
#
#   scripts/package-mac.sh mac-arm64
#
# Signing: DITTO_SIGN_IDENTITY="Developer ID Application: ..." (optional).
# Notarization: DITTO_NOTARY_PROFILE=<notarytool keychain profile> (optional).
source "$(dirname "$0")/common.sh"

config="${1:-mac-arm64}"
arch=arm64; [[ "$config" == mac-x64 ]] && arch=x86_64
app="$SRC_DIR/out/$config/Ditto.app"
runtime="$WORK_DIR/runtime-$arch/ditto-inference"
[[ -d "$app" ]] || die "No $app; run scripts/build.sh $config"
[[ -x "$runtime" ]] || die "No runtime; run scripts/build-runtime.sh $arch"

framework="$app/Contents/Frameworks/Ditto Framework.framework/Versions/Current"
mkdir -p "$framework/Helpers"
cp "$runtime" "$framework/Helpers/ditto-inference"

if [[ -n "${DITTO_SIGN_IDENTITY:-}" ]]; then
  log "Signing"
  codesign --force --options runtime --timestamp \
    --sign "$DITTO_SIGN_IDENTITY" "$framework/Helpers/ditto-inference"
  codesign --force --deep --options runtime --timestamp \
    --sign "$DITTO_SIGN_IDENTITY" "$app"
else
  log "No DITTO_SIGN_IDENTITY: ad-hoc signing (Gatekeeper will warn on other Macs)"
  codesign --force --deep --sign - "$app"
fi

dist="$DITTO_ROOT/dist"
mkdir -p "$dist"
dmg="$dist/Ditto-$config.dmg"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -R "$app" "$staging/"
ln -s /Applications "$staging/Applications"
rm -f "$dmg"
hdiutil create -volname Ditto -srcfolder "$staging" -fs APFS -format ULFO "$dmg"

if [[ -n "${DITTO_SIGN_IDENTITY:-}" && -n "${DITTO_NOTARY_PROFILE:-}" ]]; then
  log "Notarizing"
  codesign --sign "$DITTO_SIGN_IDENTITY" --timestamp "$dmg"
  xcrun notarytool submit "$dmg" --keychain-profile "$DITTO_NOTARY_PROFILE" --wait
  xcrun stapler staple "$dmg"
fi
shasum -a 256 "$dmg" | tee "$dmg.sha256"
log "Packaged $dmg"
