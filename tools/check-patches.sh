#!/usr/bin/env bash
# Verifies chromium/patches/*.patch apply to the pinned Chromium version
# without a checkout: downloads only the files the patches touch (from
# Chromium's Gitiles) and dry-runs each patch against them.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(tr -d '[:space:]' < "$root/chromium/VERSION")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

files="$(grep -h '^--- a/' "$root"/chromium/patches/*.patch | sed 's#^--- a/##' | sort -u)"
for file in $files; do
  mkdir -p "$work/$(dirname "$file")"
  url="https://chromium.googlesource.com/chromium/src/+/refs/tags/$version/$file?format=TEXT"
  for attempt in 1 2 3 4; do
    if curl -fsS --max-time 120 "$url" | base64 -d > "$work/$file"; then
      break
    fi
    [[ $attempt == 4 ]] && { echo "could not download $file" >&2; exit 1; }
    sleep $((attempt * 2))
  done
done

cd "$work"
status=0
for patch in "$root"/chromium/patches/*.patch; do
  # Same command scripts/patch.sh uses.
  if git apply --check "$patch"; then
    echo "ok   $(basename "$patch")"
  else
    echo "FAIL $(basename "$patch")"
    status=1
  fi
done
exit $status
