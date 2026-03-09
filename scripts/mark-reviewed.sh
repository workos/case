#!/usr/bin/env bash
# Create .case-reviewed marker with evidence that code review was performed.
# The pre-PR hook checks that this file exists and contains critical: 0.
#
# Usage: mark-reviewed.sh [--critical N] [--warnings N] [--info N]
# Reads optional detailed findings from stdin.
# Only creates .case-reviewed if --critical is 0 (or omitted).

set -euo pipefail

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
  echo "ERROR: Cannot create .case-reviewed with $CRITICAL critical findings" >&2
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > .case-reviewed << EOF
timestamp: ${TIMESTAMP}
critical: ${CRITICAL}
warnings: ${WARNINGS}
info: ${INFO}
EOF

echo ".case-reviewed created (${WARNINGS} warnings, ${INFO} info)" >&2

# Update task JSON if .case-active present
CASE_REPO="/Users/nicknisi/Developer/case"
if [[ -f ".case-active" ]]; then
  TASK_ID=$(cat .case-active | tr -d '[:space:]')
  TASK_JSON="${CASE_REPO}/tasks/active/${TASK_ID}.task.json"
  if [[ -n "$TASK_ID" && -f "$TASK_JSON" ]]; then
    bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" agent reviewer status completed 2>/dev/null || true
    bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" agent reviewer completed now 2>/dev/null || true
  fi
fi
