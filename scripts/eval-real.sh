#!/usr/bin/env bash
# Runs the agent eval (agent/eval) against real models: llama.cpp's server
# (the build Ditto bundles) with a responder and a decider downloaded from
# Hugging Face. macOS on Apple silicon; the first run downloads ~2.5 GB.
#
#   scripts/eval-real.sh [report.md]
#   LLM=… DECIDER=… MODE=hybrid MIN=0.8 scripts/eval-real.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
report="${1:-$root/eval-report.md}"
llm="${LLM:-LiquidAI/LFM3-1.7B-GGUF:Q4_K_M}"
decider="${DECIDER:-LiquidAI/d1-omni-600M-GGUF:Q8_0}"
work="${DITTO_EVAL_DIR:-$root/build/eval}"
mkdir -p "$work/models"

# shellcheck source=runtime.env
source "$root/scripts/runtime.env"
if [[ ! -x "$work/llama/llama-server" ]]; then
  curl -fL --retry 4 -o "$work/llama.tar.gz" "$LLAMA_ARM64_URL"
  echo "$LLAMA_ARM64_SHA256  $work/llama.tar.gz" | shasum -a 256 -c -
  rm -rf "$work/llama" && mkdir -p "$work/llama"
  tar -xzf "$work/llama.tar.gz" -C "$work/llama" --strip-components 1
fi

(cd "$root/agent" && [[ -d node_modules ]] || npm ci --silent)
(cd "$root/agent" && npx tsc -p .)
node -e "import('$root/agent/dist/src/models/catalog.js').then(m => process.stdout.write(m.routerPresetIni()))" \
  > "$work/preset.ini"

port=8093
key="$(openssl rand -hex 24)"
LLAMA_CACHE="$work/models" "$work/llama/llama-server" --host 127.0.0.1 --port "$port" \
  --api-key "$key" --models-preset "$work/preset.ini" --models-max 2 --no-webui \
  > "$work/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
for _ in $(seq 60); do
  curl -sf -H "Authorization: Bearer $key" "http://127.0.0.1:$port/models" >/dev/null && break
  sleep 1
done

cd "$root/agent"
node dist/eval/run.js --runtime "http://127.0.0.1:$port" --api-key "$key" \
  --llm "$llm" --decider "$decider" --mode "${MODE:-hybrid}" --download \
  --report "$report" --min "${MIN:-0}"
