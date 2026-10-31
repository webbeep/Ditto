#!/usr/bin/env bash
# Runs a built Ditto.app's self-test (app/Sources/Ditto/App/SelfTest.swift)
# with a fresh profile, screenshots each stage it announces, and fails
# unless every check passed.
#
#   scripts/smoke-app.sh build/app-arm64/Ditto.app [screenshot dir]
set -euo pipefail
app="$(cd "$1" && pwd)"
shots="${2:-$(pwd)/screenshots}"
mkdir -p "$shots"
report="$(mktemp -d)/report.json"
home="$(mktemp -d)"

# A fresh profile: HOME decides ~/Library/Application Support.
HOME="$home" DITTO_SELF_TEST="$report" "$app/Contents/MacOS/Ditto" > "$shots/app.log" 2>&1 &
pid=$!
taken=""
for _ in $(seq 240); do
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
