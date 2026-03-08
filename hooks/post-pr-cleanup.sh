#!/usr/bin/env bash
# Post-PR cleanup hook for case harness
# After successful gh pr create:
# 1. Updates task JSON status to pr-opened (if .task.json exists)
# 2. Falls back to moving task .md files from active/ to done/ (old format)
# 3. Removes marker files

set -euo pipefail

CASE_REPO="/Users/nicknisi/Developer/case"

# Read hook input from stdin
INPUT=$(cat)

# Extract the command
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

# Only act on gh pr create
if [[ "$COMMAND" != *"gh pr create"* ]]; then
  exit 0
fi

# Try to extract PR URL from tool output
PR_URL=$(echo "$INPUT" | python3 -c "
import sys, json, re
d = json.load(sys.stdin)
out = d.get('tool_output', '') or ''
# gh pr create outputs the PR URL as the last line
m = re.search(r'https://github\.com/[^\s]+/pull/\d+', out)
print(m.group(0) if m else '')
" 2>/dev/null || echo "")

UPDATED_JSON=false

# Deterministic task targeting: read .case-active for task ID
if [[ -f ".case-active" ]]; then
  TASK_ID=$(cat .case-active | tr -d '[:space:]')
  if [[ -n "$TASK_ID" ]]; then
    TASK_JSON="${CASE_REPO}/tasks/active/${TASK_ID}.task.json"
    if [[ -f "$TASK_JSON" ]]; then
      bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" status pr-opened 2>/dev/null && UPDATED_JSON=true
      if [[ -n "$PR_URL" ]]; then
        bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" prUrl "$PR_URL" 2>/dev/null || true
      fi
    fi
  fi
fi

# Fallback for old-format tasks (no .task.json): move .md files
if [[ "$UPDATED_JSON" == "false" ]]; then
  if [[ -d "$CASE_REPO/tasks/active" && -d "$CASE_REPO/tasks/done" ]]; then
    for task_file in "$CASE_REPO/tasks/active"/*.md; do
      if [[ -f "$task_file" ]]; then
        mv "$task_file" "$CASE_REPO/tasks/done/"
      fi
    done
  fi
fi

# Clean up all marker files
rm -f .case-active .case-tested .case-manual-tested

exit 0
