#!/usr/bin/env bash
# Deletes test data and other content a macOS/iOS release build never reads.
# Build files (BUILD.gn, *.gni) are kept so `gn gen` still resolves every
# target; only the payload goes. Saves ~8 GB on a fresh checkout.
source "$(dirname "$0")/common.sh"

cd "$SRC_DIR"
while IFS= read -r dir; do
  [[ -z "$dir" || "$dir" == \#* ]] && continue
  [[ -d "$dir" ]] || continue
  log "Pruning $dir"
  find "$dir" -type f ! -name 'BUILD.gn' ! -name '*.gni' ! -name '*.pydeps' ! -name 'DEPS' \
       ! -name 'OWNERS' ! -name '*.grd' ! -name '*.grdp' -delete
done < "$DITTO_ROOT/chromium/prune.list"
