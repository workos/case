#!/usr/bin/env bash
set -uo pipefail
# Note: NOT set -e — we capture check.sh failures in the output

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET_REPO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) TARGET_REPO="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Run check.sh, capture output and exit code
ARGS=""
if [[ -n "$TARGET_REPO" ]]; then
  ARGS="--repo $TARGET_REPO"
fi

OUTPUT=$(bash "$CASE_DIR/scripts/check.sh" $ARGS 2>&1)
EXIT_CODE=$?

# Parse output for pass/fail counts
TOTAL_LINE=$(echo "$OUTPUT" | grep "^Summary:" || echo "Summary: 0/0")
PASSED=$(echo "$TOTAL_LINE" | grep -oE '[0-9]+/' | tr -d '/')
TOTAL=$(echo "$TOTAL_LINE" | grep -oE '/[0-9]+' | tr -d '/')
FAILED=$((${TOTAL:-0} - ${PASSED:-0}))

# Extract individual failures
FAILURES=$(echo "$OUTPUT" | grep "\[FAIL\]" | sed 's/^  //' || echo "")

# Output structured JSON
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
node -e "
  const failures = $(echo "$FAILURES" | node -e "
    const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n').filter(Boolean);
    console.log(JSON.stringify(lines));
  ");
  console.log(JSON.stringify({
    timestamp: '$TIMESTAMP',
    status: $EXIT_CODE === 0 ? 'clean' : 'drift_detected',
    passed: ${PASSED:-0},
    failed: ${FAILED:-0},
    total: ${TOTAL:-0},
    failures: failures,
    repo_filter: '$TARGET_REPO' || null
  }, null, 2));
"

# Always exit 0 for /loop compatibility
exit 0
