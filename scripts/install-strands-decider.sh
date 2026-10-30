#!/usr/bin/env bash
# Optional: the strands-decider sidecar for Amazon's strands deciders
# (LoRA + readout head on Qwen3.5 / Gemma 4; served with PyTorch, MPS on
# Apple silicon). d1 deciders do not need this: llama.cpp serves them.
#
#   scripts/install-strands-decider.sh [model]
set -euo pipefail
model="${1:-StrandsAgents/strands-decider-2B-qwen3.5-v1-2610}"
port="${DITTO_STRANDS_PORT:-8737}"

if ! command -v uv >/dev/null; then
  echo "Installing uv (Python package manager)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
uv tool install --upgrade "strands-decider[vision]"
echo "Serving $model on 127.0.0.1:$port (Ctrl-C to stop)"
exec strands-decider serve "$model" --port "$port"
