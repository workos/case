#!/usr/bin/env bash
# Create .case-tested marker with evidence that tests actually ran.
# The pre-PR hook checks that this file contains real test output, not just "touch".
#
# Usage: bash /path/to/mark-tested.sh <test-command-output-file>
# Or pipe test output: pnpm test 2>&1 | bash /path/to/mark-tested.sh
#
# The marker file contains a timestamp and a hash of the test output,
# proving tests were actually executed.

set -euo pipefail

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [[ $# -ge 1 && -f "$1" ]]; then
  # Read from file
  OUTPUT_HASH=$(shasum -a 256 "$1" | cut -d' ' -f1)
  PASS_COUNT=$(grep -ciE "(pass|passed|✓|ok)" "$1" 2>/dev/null || echo "0")
  FAIL_COUNT=$(grep -ciE "(fail|failed|✗|error)" "$1" 2>/dev/null || echo "0")
else
  # Read from stdin
  TMPFILE=$(mktemp)
  cat > "$TMPFILE"
  OUTPUT_HASH=$(shasum -a 256 "$TMPFILE" | cut -d' ' -f1)
  PASS_COUNT=$(grep -ciE "(pass|passed|✓|ok)" "$TMPFILE" 2>/dev/null || echo "0")
  FAIL_COUNT=$(grep -ciE "(fail|failed|✗|error)" "$TMPFILE" 2>/dev/null || echo "0")
  rm -f "$TMPFILE"
fi

cat > .case-tested << EOF
timestamp: ${TIMESTAMP}
output_hash: ${OUTPUT_HASH}
pass_indicators: ${PASS_COUNT}
fail_indicators: ${FAIL_COUNT}
EOF

echo ".case-tested created (hash: ${OUTPUT_HASH:0:12}...)" >&2

# Update task JSON if .case-active contains a task ID
CASE_REPO="/Users/nicknisi/Developer/case"
if [[ -f ".case-active" ]]; then
  TASK_ID=$(cat .case-active | tr -d '[:space:]')
  TASK_JSON="${CASE_REPO}/tasks/active/${TASK_ID}.task.json"
  if [[ -n "$TASK_ID" && -f "$TASK_JSON" ]]; then
    bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" tested true --from-marker 2>/dev/null || true
  fi
fi
