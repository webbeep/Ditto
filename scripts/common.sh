# Shared settings for the build scripts. Source, don't run.
set -euo pipefail

DITTO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROMIUM_VERSION="$(tr -d '[:space:]' < "$DITTO_ROOT/chromium/VERSION")"
# llama.cpp release that serves /v1/systemone (d1) and router mode.
LLAMA_CPP_VERSION="${LLAMA_CPP_VERSION:-v0.8.0}"

# The Chromium checkout is ~30 GB even trimmed to macOS/iOS; keep it out of
# this repository.
WORK_DIR="${DITTO_WORK_DIR:-$DITTO_ROOT/build}"
SRC_DIR="$WORK_DIR/src"
DEPOT_TOOLS="${DEPOT_TOOLS:-$WORK_DIR/depot_tools}"
export PATH="$DEPOT_TOOLS:$PATH"
# Skip depot_tools' self-update on every command.
export DEPOT_TOOLS_UPDATE=0

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
