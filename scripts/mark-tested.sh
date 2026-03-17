#!/usr/bin/env bash
# Create .case-tested marker with evidence that tests actually ran.
# The pre-PR hook checks that this file contains real test output, not just "touch".
#
# Usage: bash /path/to/mark-tested.sh <test-command-output-file>
# Or pipe test output: pnpm test 2>&1 | bash /path/to/mark-tested.sh
#
# Supports two input modes:
#   1. JSON (vitest --reporter=json) — routed through parse-test-output.sh for
#      structured evidence (pass/fail counts, duration, per-file breakdown)
#   2. Plain text — falls back to grep heuristic for pass/fail indicators
#
# The marker file contains a timestamp and a hash of the test output,
# proving tests were actually executed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Resolve input to a temp file so we can inspect and hash it
if [[ $# -ge 1 && -f "$1" ]]; then
  TMPFILE="$1"
  CLEANUP_TMP=false
else
  TMPFILE=$(mktemp)
  cat > "$TMPFILE"
  CLEANUP_TMP=true
fi

# Hash is always computed on raw output (same evidence chain regardless of format)
OUTPUT_HASH=$(shasum -a 256 "$TMPFILE" | cut -d' ' -f1)

# Detect JSON input: first non-whitespace character is '{'
FIRST_CHAR=$(sed -n 's/^[[:space:]]*//; /./{ p; q; }' "$TMPFILE" | cut -c1)

if [[ "$FIRST_CHAR" == "{" ]]; then
  # JSON mode — route through parse-test-output.sh for structured evidence
  STRUCTURED=$("$SCRIPT_DIR/parse-test-output.sh" "$TMPFILE")
  PASS_COUNT=$(echo "$STRUCTURED" | grep '^passed:' | cut -d' ' -f2)
  FAIL_COUNT=$(echo "$STRUCTURED" | grep '^failed:' | cut -d' ' -f2)

  cat > .case-tested << EOF
timestamp: ${TIMESTAMP}
output_hash: ${OUTPUT_HASH}
pass_indicators: ${PASS_COUNT}
fail_indicators: ${FAIL_COUNT}
${STRUCTURED}
EOF
else
  # Plain text mode — grep heuristic (original behavior)
  PASS_COUNT=$(grep -ciE "(pass|passed|✓|ok)" "$TMPFILE" 2>/dev/null || echo "0")
  FAIL_COUNT=$(grep -ciE "(fail|failed|✗|error)" "$TMPFILE" 2>/dev/null || echo "0")

  cat > .case-tested << EOF
timestamp: ${TIMESTAMP}
output_hash: ${OUTPUT_HASH}
pass_indicators: ${PASS_COUNT}
fail_indicators: ${FAIL_COUNT}
EOF
fi

if [[ "$CLEANUP_TMP" == true ]]; then
  rm -f "$TMPFILE"
fi

echo ".case-tested created (hash: ${OUTPUT_HASH:0:12}...)" >&2

# Update task JSON if .case-active contains a task ID
CASE_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f ".case-active" ]]; then
  TASK_ID=$(cat .case-active | tr -d '[:space:]')
  TASK_JSON="${CASE_REPO}/tasks/active/${TASK_ID}.task.json"
  if [[ -n "$TASK_ID" && -f "$TASK_JSON" ]]; then
    bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" tested true --from-marker 2>/dev/null || true
  else
    echo "WARNING: .case-active contains '${TASK_ID}' but task JSON not found at ${TASK_JSON}" >&2
  fi
else
  echo "WARNING: .case-active not found — task JSON 'tested' field will NOT be updated. Marker file created locally only." >&2
fi
