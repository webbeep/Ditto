#!/usr/bin/env bash
# Checks a compiled Ditto.app (CI, macOS):
#  1. the signature is valid and the bundle is branded;
#  2. the browser starts and loads web pages;
#  3. the new tab page is Ditto home and the agent page renders, both with
#     their scripts and Mojo bindings working;
#  4. the bundled model runtime runs.
#
#   scripts/smoke-native.sh path/to/Ditto.app
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$(cd "$1" && pwd)"
tmp="$(mktemp -d)"
port=9556
browser=""
cleanup() {
  [ -n "$browser" ] && kill "$browser" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

echo "==> Bundle"
codesign --verify --deep --strict --verbose=1 "$app"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" = app.ditto.browser ]
runtime="$app/Contents/Frameworks/Ditto Framework.framework/Versions/Current/Helpers/ditto-runtime/llama-server"
"$runtime" --version 2>&1 | head -3

echo "==> Browser, home page and agent page"
"$app/Contents/MacOS/Ditto" --headless=new --use-mock-keychain --user-data-dir="$tmp/profile" \
  --remote-debugging-port=$port --no-first-run about:blank >"$tmp/browser.log" 2>&1 &
browser=$!
for _ in $(seq 60); do
  curl -sf "http://127.0.0.1:$port/json/version" >/dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$port/json/version"
(cd "$tmp" && npm install --silent --no-save playwright-core@1.63.0 >/dev/null)
NODE_PATH="$tmp/node_modules" node "$here/smoke-native.mjs" "http://127.0.0.1:$port" ||
  { tail -80 "$tmp/browser.log"; exit 1; }
echo "Smoke test passed"
