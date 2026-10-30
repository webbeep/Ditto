#!/usr/bin/env bash
# Builds the local model runtime: llama.cpp's llama-server (router mode,
# Metal), shipped inside Ditto.app as `ditto-inference`.
#
#   scripts/build-runtime.sh [arm64|x86_64]
source "$(dirname "$0")/common.sh"

arch="${1:-arm64}"
src="$WORK_DIR/llama.cpp"
out="$WORK_DIR/runtime-$arch"

if [[ ! -d "$src/.git" ]]; then
  git clone --depth 1 --branch "$LLAMA_CPP_VERSION" https://github.com/ggml-org/llama.cpp "$src"
fi
git -C "$src" fetch --depth 1 origin "refs/tags/$LLAMA_CPP_VERSION:refs/tags/$LLAMA_CPP_VERSION"
git -C "$src" checkout -q "$LLAMA_CPP_VERSION"

metal=ON
[[ "$arch" == x86_64 ]] && metal=OFF  # Intel Macs: CPU (Accelerate) only.

log "Building llama-server $LLAMA_CPP_VERSION for $arch"
cmake -S "$src" -B "$out" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$arch" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL="$metal" \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_NATIVE=OFF \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_UI=OFF \
  -DLLAMA_USE_PREBUILT_UI=OFF \
  -DLLAMA_OPENSSL=ON
cmake --build "$out" --target llama-server -j
cp "$out/bin/llama-server" "$out/ditto-inference"
log "Runtime: $out/ditto-inference"
