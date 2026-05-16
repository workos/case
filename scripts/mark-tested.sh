#!/usr/bin/env bash
# Create .case/<task-slug>/tested marker with evidence that tests actually ran.
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
CASE_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Resolve task slug from .case/active
TASK_SLUG=""
if [[ -f ".case/active" ]]; then
  TASK_SLUG=$(cat .case/active | tr -d '[:space:]')
fi
if [[ -z "$TASK_SLUG" ]]; then
  echo "ERROR: No active task — .case/active is missing or empty. Run the orchestrator first." >&2
  exit 1
fi

MARKER_DIR=".case/${TASK_SLUG}"
mkdir -p "$MARKER_DIR"

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

  cat > "${MARKER_DIR}/tested" << EOF
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

  cat > "${MARKER_DIR}/tested" << EOF
timestamp: ${TIMESTAMP}
output_hash: ${OUTPUT_HASH}
pass_indicators: ${PASS_COUNT}
fail_indicators: ${FAIL_COUNT}
EOF
fi

if [[ "$CLEANUP_TMP" == true ]]; then
  rm -f "$TMPFILE"
fi

echo ".case/${TASK_SLUG}/tested created (hash: ${OUTPUT_HASH:0:12}...)" >&2

# Resolve data dir using the same XDG resolution order as the TypeScript code.
if [[ -n "${CASE_DATA_DIR:-}" ]]; then
  DATA_ROOT="$CASE_DATA_DIR"
elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
  DATA_ROOT="$XDG_CONFIG_HOME/case"
elif [[ -n "${HOME:-}" ]]; then
  DATA_ROOT="$HOME/.config/case"
else
  DATA_ROOT="$CASE_REPO"
fi

# Update task JSON — check data dir first, fall back to package root.
TASK_JSON="${DATA_ROOT}/tasks/active/${TASK_SLUG}.task.json"
if [[ ! -f "$TASK_JSON" ]]; then
  TASK_JSON="${CASE_REPO}/tasks/active/${TASK_SLUG}.task.json"
fi
if [[ -f "$TASK_JSON" ]]; then
  bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" tested true --from-marker 2>/dev/null || true
else
  echo "WARNING: task JSON not found at ${TASK_JSON}" >&2
fi
