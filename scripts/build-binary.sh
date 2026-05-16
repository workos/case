#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DIST="$ROOT/dist"

rm -rf "$DIST"
mkdir -p "$DIST"

echo "--- Writing pi-agent stub package.json ---"
PI_VERSION=$(jq -r '.version' "$ROOT/node_modules/@mariozechner/pi-coding-agent/package.json")
cat > "$DIST/package.json" <<EOF
{"name":"@mariozechner/pi-coding-agent","version":"${PI_VERSION}","piConfig":{"name":"pi","configDir":".pi"}}
EOF

echo "--- Compiling binary ---"
bun build --compile "$ROOT/src/index.ts" --outfile "$DIST/ca"

echo "--- Done ---"
echo "Binary: $DIST/ca"
echo "Test:   $DIST/ca --help"
