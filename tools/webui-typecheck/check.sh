#!/usr/bin/env bash
# Typechecks the chrome://ditto-agent sources (overlay + agent runtime)
# against a stub of the generated Mojo bindings.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$root"/chromium/overlay/ditto/browser/resources/*.ts "$work/"
cp "$here/ditto_agent.mojom-webui.ts" "$work/"
mkdir -p "$work/agent"
cp -R "$root/agent/src/." "$work/agent/"
cat > "$work/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": [],
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["*.ts", "agent/**/*.ts"]
}
JSON
"$root/agent/node_modules/.bin/tsc" -p "$work"
echo "WebUI typecheck passed."
