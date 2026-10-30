#!/usr/bin/env bash
# Checks a built Ditto.app on macOS (CI):
#   preview/smoke-test.sh build/preview-arm64/Ditto.app
#  1. the signature is valid;
#  2. the app starts, loads web pages, and loads the agent extension;
#  3. the native host starts the bundled llama-server, which answers with
#     the API key and refuses without it, and stops it again.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$(cd "$1" && pwd)"
extension_id=gmnabdkkiapgiceenfljnbpgblepapmo
tmp="$(mktemp -d)"
port=9555
browser=""
cleanup() {
  [ -n "$browser" ] && kill "$browser" 2>/dev/null || true
  exec 3>&- 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

echo "==> Signature"
codesign --verify --deep --strict --verbose=1 "$app"

echo "==> Browser starts, renders a page, loads the agent extension"
"$app/Contents/MacOS/Ditto" --headless=new --use-mock-keychain --user-data-dir="$tmp/profile" \
  --remote-debugging-port=$port --no-first-run about:blank >"$tmp/browser.log" 2>&1 &
browser=$!
for _ in $(seq 60); do
  curl -sf "http://127.0.0.1:$port/json/version" >/dev/null && break
  sleep 1
done
curl -sf -X PUT "http://127.0.0.1:$port/json/new?https://example.com" >/dev/null
ok_page=0 ok_extension=0
for _ in $(seq 60); do
  targets=$(curl -sf "http://127.0.0.1:$port/json/list" || true)
  grep -q '"title": *"Example Domain"' <<<"$targets" && ok_page=1
  grep -q "chrome-extension://$extension_id/background.js" <<<"$targets" && ok_extension=1
  [ $ok_page = 1 ] && [ $ok_extension = 1 ] && break
  sleep 1
done
if [ $ok_page != 1 ] || [ $ok_extension != 1 ]; then
  echo "page=$ok_page extension=$ok_extension"; echo "$targets"; tail -50 "$tmp/browser.log"
  exit 1
fi
grep -q "$app/Contents/Resources/ditto/runtime-host.sh" \
  "$tmp/profile/NativeMessagingHosts/app.ditto.runtime.json"
kill "$browser"; wait "$browser" 2>/dev/null || true; browser=""
echo "page and extension OK"

echo "==> Native host starts and stops the bundled runtime"
mkfifo "$tmp/hold"
DITTO_DATA_DIR="$tmp/data" python3 "$here/host-call.py" \
  "$app/Contents/Resources/ditto/runtime-host.sh" <"$tmp/hold" >"$tmp/reply" &
caller=$!
exec 3>"$tmp/hold"
for _ in $(seq 30); do [ -s "$tmp/reply" ] && break; sleep 1; done
cat "$tmp/reply"
rport=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['port'])" "$tmp/reply")
rkey=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['key'])" "$tmp/reply")
status=""
for _ in $(seq 60); do
  status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $rkey" \
    "http://127.0.0.1:$rport/models" || true)
  [ "$status" = 200 ] && break
  sleep 1
done
[ "$status" = 200 ] || { echo "runtime did not answer ($status)"; cat "$tmp/data/runtime.log"; exit 1; }
anonymous=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$rport/models")
[ "$anonymous" = 401 ] || { echo "runtime answered without the key ($anonymous)"; exit 1; }
exec 3>&-   # like the browser quitting
wait "$caller"
sleep 2
if curl -s -o /dev/null "http://127.0.0.1:$rport/models"; then
  echo "runtime still running after the host exited"; exit 1
fi
echo "runtime OK (port $rport, key required, stopped on disconnect)"
echo "Smoke test passed."
