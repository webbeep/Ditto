#!/usr/bin/env bash
# Runs a built Ditto.app's self-test (app/Sources/Ditto/App/SelfTest.swift)
# with a fresh profile, screenshots each stage it announces, and fails
# unless every check passed. With Node and agent/ installed, the agent also
# runs a task in the app, against the mock model runtime and the test site.
#
#   scripts/smoke-app.sh build/app-arm64/Ditto.app [screenshot dir]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
app="$(cd "$1" && pwd)"
shots="${2:-$(pwd)/screenshots}"
mkdir -p "$shots"
work="$(mktemp -d)"
report="$work/report.json"
home="$(mktemp -d)"

services=""
runtime_url=""
runtime_key=""
test_site=""
field() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' \
    "$work/services.json" "$1"
}
if command -v node >/dev/null && [[ -d "$root/agent/node_modules" ]]; then
  (cd "$root/agent" && npx tsc -p .)
  node "$root/agent/dist/dev/selftest_services.js" > "$work/services.json" &
  services=$!
  for _ in $(seq 50); do [[ -s "$work/services.json" ]] && break; sleep 0.2; done
  runtime_url=$(field runtime)
  runtime_key=$(field key)
  test_site=$(field site)
fi
trap '[[ -n "$services" ]] && kill "$services" 2>/dev/null || true' EXIT

# A fresh profile: HOME decides ~/Library/Application Support.
HOME="$home" DITTO_SELF_TEST="$report" DITTO_TEST_RUNTIME="$runtime_url" \
  DITTO_TEST_RUNTIME_KEY="$runtime_key" DITTO_TEST_SITE="$test_site" \
  "$app/Contents/MacOS/Ditto" > "$shots/app.log" 2>&1 &
pid=$!
taken=""
for _ in $(seq 400); do
  if [[ -f "$report" ]]; then
    stage=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('stage',''))" "$report" 2>/dev/null || true)
    if [[ "$stage" == screenshot-* && "$taken" != *"$stage"* ]]; then
      sleep 1.5
      screencapture -x "$shots/${stage#screenshot-}.png" || true
      taken="$taken $stage"
    fi
    [[ "$stage" == passed || "$stage" == failed ]] && break
  fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
kill "$pid" 2>/dev/null || true
cat "$report" 2>/dev/null || echo "no report"
grep -q '"stage" : "passed"' "$report"
