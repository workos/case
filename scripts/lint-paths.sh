#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

fail=0

while IFS= read -r file; do
  while IFS= read -r match; do
    echo "ERROR: hardcoded path in $file: $match"
    fail=1
  done < <(grep -n '/Users/' "$file" 2>/dev/null || true)
done < <(find "$ROOT/scripts" -name '*.sh' \
         "$ROOT/agents" -name '*.md' \
         "$ROOT/AGENTS.md" "$ROOT/CLAUDE.md" "$ROOT/README.md" \
         -not -path '*/node_modules/*' 2>/dev/null)

if [ "$fail" -eq 1 ]; then
  echo "FAIL: hardcoded /Users/ paths found in .sh/.md files"
  exit 1
fi

echo "PASS: no hardcoded paths in scripts/ or agents/"
