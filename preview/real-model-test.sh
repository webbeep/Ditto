#!/usr/bin/env bash
# Runs the agent with real models in the runtime bundled in Ditto.app (CI):
#   preview/real-model-test.sh build/preview-arm64/Ditto.app
# Downloads LFM3 1.7B (responder) and d1 Omni 600M (decider) from Hugging
# Face through the runtime, then runs the same task as the unit tests in
# all three modes against the local test site in Chromium.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
app="$(cd "$1" && pwd)"
tmp="$(mktemp -d)"
trap 'exec 3>&- 2>/dev/null || true; rm -rf "$tmp"' EXIT

mkfifo "$tmp/hold"
DITTO_DATA_DIR="$tmp/data" python3 "$root/preview/host-call.py" \
  "$app/Contents/Resources/ditto/runtime-host.sh" <"$tmp/hold" >"$tmp/reply" &
exec 3>"$tmp/hold"
for _ in $(seq 30); do [ -s "$tmp/reply" ] && break; sleep 1; done
port=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['port'])" "$tmp/reply")
key=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['key'])" "$tmp/reply")
for _ in $(seq 60); do
  curl -sf -H "Authorization: Bearer $key" "http://127.0.0.1:$port/models" >/dev/null && break
  sleep 1
done

llm=LiquidAI/LFM3-1.7B-GGUF:Q4_K_M
decider=LiquidAI/d1-omni-600M-GGUF:Q8_0
task="What is the price of the Acme Widget Pro?"
# Hybrid (the default) and decider-only must answer; LLM-only (a 1.7B
# model navigating alone) is reported.
status=0
for mode in hybrid decider-only llm-only; do
  echo "=========== $mode"
  if ! node "$root/agent/dist/dev/cli.js" --runtime "http://127.0.0.1:$port" --api-key "$key" \
      --fixture --download --budget-mb 6000 --mode "$mode" --llm "$llm" --decider "$decider" \
      --expect '\$49' "$task"; then
    if [ "$mode" != llm-only ]; then
      status=1
    else
      echo "::warning::real-model agent run failed in $mode mode"
    fi
  fi
done
echo "=========== runtime log (tail)"
tail -40 "$tmp/data/runtime.log" || true
exit $status
