#!/bin/bash
# Native messaging host "app.ditto.runtime" (preview build).
#
# The Ditto agent extension connects to this host only when the agent is
# used. The host starts the bundled llama-server in router mode on a random
# loopback port with a per-launch API key, and stops it (and every model it
# loaded) as soon as the extension disconnects or the browser quits. The
# full build does the same in C++ (InferenceSupervisor).
#
# Protocol (Chrome native messaging: 32-bit native-endian length + JSON):
#   {"cmd":"start","marginMb":2048} -> {"ok":true,"port":N,"key":"..."}
#   {"cmd":"stop"}                  -> {"ok":true}
#
# Written for macOS's /bin/bash 3.2.

set -u
export LC_ALL=C

here="$(cd "$(dirname "$0")" && pwd)"
# In Ditto.app the runtime binaries are nested code in Contents/Helpers
# (covered by the app's signature); the preset is a resource next to this
# script.
server="${DITTO_RUNTIME_SERVER:-}"
if [ -z "$server" ]; then
  for candidate in "$here/../../Helpers/ditto-runtime/llama-server" "$here/runtime/llama-server"; do
    if [ -x "$candidate" ]; then
      server="$candidate"
      break
    fi
  done
fi
preset="$here/runtime/preset.ini"
data="${DITTO_DATA_DIR:-$HOME/Library/Application Support/Ditto}"
models="$data/Ditto Models"
log="$data/runtime.log"

pid=""
port=""
key=""

# Reads one message; fails at end of input (the browser disconnected).
read_message() {
  local len
  len=$(dd bs=1 count=4 2>/dev/null | od -An -tu4 | tr -d ' \n')
  [ -n "$len" ] || return 1
  # Byte at a time: never reads past this message on a pipe.
  dd bs=1 count="$len" 2>/dev/null
}

# Writes one message. Messages are ASCII JSON, so ${#} counts bytes.
send() {
  local len=${#1}
  printf "$(printf '\\%03o\\%03o\\%03o\\%03o' $((len & 255)) $(((len >> 8) & 255)) \
    $(((len >> 16) & 255)) $(((len >> 24) & 255)))"
  printf '%s' "$1"
}

running() {
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

stop_runtime() {
  if running; then
    # The router runs in its own process group (set -m below); this also
    # ends the model instances it spawned.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      running || break
      sleep 0.5
    done
    running && kill -KILL -- "-$pid" 2>/dev/null
  fi
  pid=""
}

start_runtime() {
  local margin
  margin=$(printf '%s' "$1" | sed -n 's/.*"marginMb":\([0-9][0-9]*\).*/\1/p')
  margin=${margin:-2048}
  if running; then
    send "{\"ok\":true,\"port\":$port,\"key\":\"$key\"}"
    return
  fi
  if [ -z "$server" ] || [ ! -x "$server" ]; then
    send '{"ok":false,"error":"model runtime missing from the app bundle"}'
    return
  fi
  if [ "$(uname)" = Darwin ]; then
    # Downloaded apps carry a quarantine flag that would stop the runtime
    # from launching after the user approved Ditto itself.
    xattr -dr com.apple.quarantine "$(dirname "$server")" 2>/dev/null || true
  fi
  mkdir -p "$models"
  key=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')
  local attempt
  for attempt in 1 2 3 4 5; do
    port=$((20000 + $(od -An -tu2 -N2 /dev/urandom | tr -d ' \n') % 40000))
    set -m
    LLAMA_CACHE="$models" "$server" --host 127.0.0.1 --port "$port" \
      --api-key "$key" --models-preset "$preset" --models-max 2 \
      --models-memory-margin "$margin" --sleep-idle-seconds 300 --no-webui \
      </dev/null >>"$log" 2>&1 &
    pid=$!
    set +m
    # A port clash makes the server exit at once; try another port.
    sleep 1
    running && break
    pid=""
  done
  if running; then
    send "{\"ok\":true,\"port\":$port,\"key\":\"$key\"}"
  else
    send '{"ok":false,"error":"model runtime failed to start; see runtime.log"}'
  fi
}

mkdir -p "$data"
trap 'stop_runtime; exit 0' EXIT TERM INT HUP

while message=$(read_message); do
  case "$message" in
    *'"cmd":"start"'*) start_runtime "$message" ;;
    *'"cmd":"stop"'*) stop_runtime; send '{"ok":true}' ;;
    *) send '{"ok":false,"error":"unknown command"}' ;;
  esac
done
