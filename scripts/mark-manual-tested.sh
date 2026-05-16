#!/usr/bin/env bash
# Create .case/<task-slug>/manual-tested marker with verification evidence.
# The pre-PR hook checks this file contains an "evidence:" line.
#
# Usage:
#   bash /path/to/mark-manual-tested.sh              # Playwright mode (default)
#   bash /path/to/mark-manual-tested.sh --library     # Library mode (test output)
#
# Playwright mode: checks for recent screenshots (.playwright-cli/ or /tmp/*.png)
# Library mode: pipe test output via stdin. Evidence = test output hash.
#   Example: pnpm test 2>&1 | bash /path/to/mark-manual-tested.sh --library

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

EVIDENCE_FOUND=false
EVIDENCE_DETAILS=""
MODE="playwright"

if [[ "${1:-}" == "--library" ]]; then
  MODE="library"
fi

if [[ "$MODE" == "library" ]]; then
  # Library mode: read test output from stdin, hash it as evidence
  TMPFILE=$(mktemp)
  cat > "$TMPFILE"
  FILE_SIZE=$(wc -c < "$TMPFILE" | tr -d ' ')
  if [[ "$FILE_SIZE" -lt 10 ]]; then
    rm -f "$TMPFILE"
    echo "REFUSED: No test output piped to stdin. Usage: pnpm test 2>&1 | bash $0 --library" >&2
    exit 1
  fi
  OUTPUT_HASH=$(shasum -a 256 "$TMPFILE" | cut -d' ' -f1)
  PASS_COUNT=$(grep -ciE "(pass|passed|✓|ok)" "$TMPFILE" 2>/dev/null || echo "0")
  rm -f "$TMPFILE"
  if [[ "$PASS_COUNT" -lt 1 ]]; then
    echo "REFUSED: Test output contains no pass indicators. Tests may have failed." >&2
    exit 1
  fi
  EVIDENCE_FOUND=true
  EVIDENCE_DETAILS="library-test-verification: output_hash=${OUTPUT_HASH:0:16} pass_indicators=${PASS_COUNT}"
else
  # Playwright mode: check for recent screenshots
  if [[ -d ".playwright-cli" ]]; then
    RECENT_FILES=$(find .playwright-cli -name "*.png" -mmin -60 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$RECENT_FILES" -gt 0 ]]; then
      EVIDENCE_FOUND=true
      EVIDENCE_DETAILS="playwright-cli screenshots: ${RECENT_FILES} files in .playwright-cli/ (last hour)"
    fi
  fi

  if [[ "$EVIDENCE_FOUND" == "false" ]]; then
    RECENT_TMP=$(find /tmp -maxdepth 1 -name "*.png" -mmin -60 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$RECENT_TMP" -gt 0 ]]; then
      EVIDENCE_FOUND=true
      EVIDENCE_DETAILS="screenshots: ${RECENT_TMP} recent .png files in /tmp (last hour)"
    fi
  fi

  if [[ "$EVIDENCE_FOUND" == "false" ]]; then
    {
      echo "REFUSED: No evidence of manual testing found."
      echo ""
      echo "Expected one of:"
      echo "  - .playwright-cli/ directory with recent screenshots"
      echo "  - Recent .png files in /tmp from playwright-cli screenshot"
      echo ""
      echo "Run playwright-cli to test the app first, then re-run this script."
    } >&2
    exit 1
  fi
fi

cat > "${MARKER_DIR}/manual-tested" << EOF
timestamp: ${TIMESTAMP}
evidence: ${EVIDENCE_DETAILS}
EOF

echo ".case/${TASK_SLUG}/manual-tested created (${EVIDENCE_DETAILS})" >&2

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
  bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" manualTested true --from-marker 2>/dev/null || true
else
  echo "WARNING: task JSON not found at ${TASK_JSON}" >&2
fi
