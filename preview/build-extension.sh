#!/usr/bin/env bash
# Builds the Ditto agent extension for the preview app:
#   preview/build-extension.sh <out_dir>
# The page (app.ts, HTML, CSS) and the agent runtime are the same sources as
# chrome://ditto-agent in the full build; only the bindings differ.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:?usage: build-extension.sh <out_dir>}"
resources="$root/chromium/overlay/ditto/browser/resources"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$resources"/*.ts "$work/"
cp "$root"/preview/extension/*.ts "$work/"
mkdir -p "$work/agent"
cp -R "$root/agent/src/." "$work/agent/"
cat > "$work/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker.ImportScripts"], "types": [],
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
    "outDir": "out", "rootDir": "."
  },
  "include": ["*.ts", "agent/**/*.ts"]
}
JSON
"$root/agent/node_modules/.bin/tsc" -p "$work"

rm -rf "$out"
mkdir -p "$out"
cp -R "$work/out/." "$out/"
rm -f "$out/chrome.d.js"
cp "$root/preview/extension/manifest.json" "$out/"
cp -R "$root/preview/extension/icons" "$out/"
cp "$resources"/*.css "$resources"/*.html "$out/"
echo "Extension built in $out"
