#!/usr/bin/env bash
# Create .case/<task-slug>/reviewed marker with evidence that code review was performed.
# The pre-PR hook checks that this file exists and contains critical: 0.
#
# Usage: mark-reviewed.sh [--critical N] [--warnings N] [--info N]
# Reads optional detailed findings from stdin.
# Only creates the marker if --critical is 0 (or omitted).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASE_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
CRITICAL=0
WARNINGS=0
INFO=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --critical) CRITICAL="$2"; shift 2 ;;
    --warnings) WARNINGS="$2"; shift 2 ;;
    --info) INFO="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ "$CRITICAL" -gt 0 ]]; then
  echo "ERROR: Cannot create reviewed marker with $CRITICAL critical findings" >&2
  exit 1
fi

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

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "${MARKER_DIR}/reviewed" << EOF
timestamp: ${TIMESTAMP}
critical: ${CRITICAL}
warnings: ${WARNINGS}
info: ${INFO}
EOF

echo ".case/${TASK_SLUG}/reviewed created (${WARNINGS} warnings, ${INFO} info)" >&2

# Update task JSON
TASK_JSON="${CASE_REPO}/tasks/active/${TASK_SLUG}.task.json"
if [[ -f "$TASK_JSON" ]]; then
  bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" agent reviewer status completed 2>/dev/null || true
  bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" agent reviewer completed now 2>/dev/null || true
fi
