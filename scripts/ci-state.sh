#!/usr/bin/env bash
# Carries a Chromium build from one GitHub-hosted job to the next (each job
# is capped at 6 hours; the whole build takes longer). Directories are
# streamed as zstd chunks to a draft release of this repository and streamed
# back by the next job, so no runner needs room for the archive itself.
#
#   scripts/ci-state.sh save <name> <path under WORK_DIR>...
#   scripts/ci-state.sh restore <name>
#   scripts/ci-state.sh put <file>       # a single file (e.g. the DMG)
#   scripts/ci-state.sh get <name> <dir>
#   scripts/ci-state.sh drop
#
# Needs gh (GH_TOKEN), zstd, GNU split (coreutils) and DITTO_STATE_TAG.
source "$(dirname "$0")/common.sh"

export DITTO_STATE_TAG="${DITTO_STATE_TAG:?set DITTO_STATE_TAG}"
export WORK_DIR
chunk=1900m  # Release assets are capped at 2 GiB.

retry() {
  local attempt
  for attempt in 1 2 3 4; do
    "$@" && return 0
    sleep $((attempt * 15))
  done
  return 1
}

assets() {
  gh release view "$DITTO_STATE_TAG" --json assets -q '.assets[].name' 2>/dev/null || true
}

ensure_release() {
  gh release view "$DITTO_STATE_TAG" >/dev/null 2>&1 ||
    gh release create "$DITTO_STATE_TAG" --draft --title "Build state $DITTO_STATE_TAG" \
      --notes "Intermediate state of a running build. Deleted when it finishes."
}

case "${1:-}" in
  save)
    name="$2"; shift 2
    ensure_release
    for asset in $(assets | grep "^$name\.part-" || true); do
      gh release delete-asset "$DITTO_STATE_TAG" "$asset" --yes
    done
    log "Saving $name ($*)"
    cd "$WORK_DIR"
    # Each chunk is written, uploaded and deleted before the next.
    COPYFILE_DISABLE=1 tar -cf - --exclude .git "$@" | zstd -T0 -3 -q |
      gsplit -b "$chunk" -d -a 3 - "$name.part-" --filter='
        set -e
        cat > "$WORK_DIR/$FILE"
        for attempt in 1 2 3 4; do
          gh release upload "$DITTO_STATE_TAG" "$WORK_DIR/$FILE" --clobber && break
          [ $attempt = 4 ] && exit 1
          sleep $((attempt * 15))
        done
        rm -f "$WORK_DIR/$FILE"'
    log "Saved $name: $(assets | grep -c "^$name\.part-") chunk(s)"
    ;;
  restore)
    name="$2"
    parts="$(assets | grep "^$name\.part-" | sort)"
    [[ -n "$parts" ]] || die "No saved state named $name in $DITTO_STATE_TAG"
    log "Restoring $name"
    mkdir -p "$WORK_DIR/.chunks"
    cd "$WORK_DIR"
    for part in $parts; do
      retry gh release download "$DITTO_STATE_TAG" -p "$part" -D .chunks --clobber >&2
      cat ".chunks/$part"
      rm -f ".chunks/$part"
    done | zstd -d -q | tar -xf -
    ;;
  put)
    ensure_release
    retry gh release upload "$DITTO_STATE_TAG" "$2" --clobber
    ;;
  get)
    retry gh release download "$DITTO_STATE_TAG" -p "$2" -D "$3" --clobber
    ;;
  drop)
    gh release delete "$DITTO_STATE_TAG" --yes || true
    ;;
  *)
    die "usage: ci-state.sh save|restore|put|get|drop ..."
    ;;
esac
