#!/usr/bin/env bash
# Post-PR cleanup hook for case harness
# After successful gh pr create:
# 1. Updates task JSON status to pr-opened (if .task.json exists)
# 2. Falls back to moving task .md files from active/ to done/ (ONLY if no .task.json files exist at all)
# 3. Removes marker files

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASE_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

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
m = re.search(r'https://github\.com/[^\s]+/pull/\d+', out)
print(m.group(0) if m else '')
" 2>/dev/null || echo "")

# Deterministic task targeting: read .case-active for task ID
if [[ -f ".case-active" ]]; then
  TASK_ID=$(cat .case-active | tr -d '[:space:]')
  if [[ -n "$TASK_ID" ]]; then
    TASK_JSON="${CASE_REPO}/tasks/active/${TASK_ID}.task.json"
    if [[ -f "$TASK_JSON" ]]; then
      # Attempt JSON update. If it fails (bad transition, etc.), log but don't fallback to moving files.
      bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" status pr-opened 2>&1 || echo "Warning: task-status update failed for ${TASK_ID}" >&2
      if [[ -n "$PR_URL" ]]; then
        bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" prUrl "$PR_URL" 2>/dev/null || true
      fi
      # JSON path was attempted — do NOT fall through to file-move
      rm -f .case-active .case-tested .case-manual-tested .case-doom-loop-state .case-reviewed
      exit 0
    else
      echo "WARNING: .case-active contains '${TASK_ID}' but task JSON not found at ${TASK_JSON}. Status will NOT transition to pr-opened." >&2
    fi
  fi
else
  echo "WARNING: .case-active not found — task JSON status will NOT transition to pr-opened and prUrl will NOT be set." >&2
fi

# Fallback ONLY for genuinely old-format tasks: no .task.json files exist in active/ at all
HAS_TASK_JSON=$(find "$CASE_REPO/tasks/active" -name "*.task.json" -maxdepth 1 2>/dev/null | head -1)
if [[ -z "$HAS_TASK_JSON" ]]; then
  if [[ -d "$CASE_REPO/tasks/active" && -d "$CASE_REPO/tasks/done" ]]; then
    for task_file in "$CASE_REPO/tasks/active"/*.md; do
      if [[ -f "$task_file" ]]; then
        mv "$task_file" "$CASE_REPO/tasks/done/"
      fi
    done
  fi
fi

# Clean up all marker files
rm -f .case-active .case-tested .case-manual-tested .case-doom-loop-state .case-reviewed

exit 0
