#!/usr/bin/env bash
# Builds until the build is done or the deadline (epoch seconds) is near,
# whichever comes first; an interrupted build resumes in the next job.
# Exit status: 0 done, 2 out of time, anything else a build error.
#
#   scripts/ci-build-slice.sh mac-arm64 <deadline>
source "$(dirname "$0")/common.sh"

config="$1"
deadline="$2"
remaining=$((deadline - $(date +%s)))
(( remaining > 900 )) || { log "No time left in this job"; exit 2; }

cd "$SRC_DIR"
log "Building for up to $((remaining / 60)) min"
status=0
# SIGINT lets the build tool record finished steps before it exits.
gtimeout -s INT -k 600 "$remaining" autoninja -C "out/$config" chrome || status=$?
case "$status" in
  0) log "Build complete" ;;
  124|130|137) log "Out of time; the next job continues"; exit 2 ;;
  *) exit "$status" ;;
esac
