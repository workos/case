#!/usr/bin/env bash
# Pre-PR check hook for case harness
# Intercepts `gh pr create` and enforces the pre-PR checklist
# Only active when .case-active marker exists (set by /case skill)

set -uo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract the command from the JSON input
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

# Only intercept gh pr create
if [[ "$COMMAND" != *"gh pr create"* ]]; then
  exit 0
fi

# Only enforce when /case is active
if [[ ! -f ".case-active" ]]; then
  exit 0
fi

# Check for stale marker (>24h old)
if [[ -f ".case-active" ]]; then
  MARKER_AGE=$(( $(date +%s) - $(stat -f %m .case-active 2>/dev/null || stat -c %Y .case-active 2>/dev/null || echo "0") ))
  if [[ $MARKER_AGE -gt 86400 ]]; then
    rm -f .case-active .case-tested .case-manual-tested
    echo "Warning: stale .case-active marker (>24h) auto-cleaned." >&2
    exit 0
  fi
fi

FAILURES=()
FIXES=()

# Check 1: Not on main/master
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
  FAILURES+=("[FAIL] Branch: currently on '$BRANCH'")
  FIXES+=("  FIX: git checkout -b fix/your-change")
fi

# Check 2: Tests were run (.case-tested marker with evidence)
if [[ ! -f ".case-tested" ]]; then
  FAILURES+=("[FAIL] Tests not verified — .case-tested marker missing")
  FIXES+=("  FIX: Run tests and pipe output: pnpm test 2>&1 | bash /Users/nicknisi/Developer/case/scripts/mark-tested.sh")
elif ! grep -q "output_hash:" ".case-tested" 2>/dev/null; then
  FAILURES+=("[FAIL] Tests marker has no evidence — was created with 'touch' instead of the mark-tested script")
  FIXES+=("  FIX: Run tests properly: pnpm test 2>&1 | bash /Users/nicknisi/Developer/case/scripts/mark-tested.sh")
fi

# Check 3: Manual testing (smart — only required if src/ files changed)
NEEDS_MANUAL_TEST=false
if git diff --name-only HEAD~1 2>/dev/null | grep -q "^src/"; then
  NEEDS_MANUAL_TEST=true
fi
# Also check staged changes if no commits yet on this branch
if git diff --name-only main 2>/dev/null | grep -q "^src/"; then
  NEEDS_MANUAL_TEST=true
fi

if [[ "$NEEDS_MANUAL_TEST" == "true" ]]; then
  if [[ ! -f ".case-manual-tested" ]]; then
    FAILURES+=("[FAIL] Manual testing not done — .case-manual-tested marker missing")
    FIXES+=("  FIX: Test in the example app with playwright-cli, then: bash /Users/nicknisi/Developer/case/scripts/mark-manual-tested.sh")
  elif ! grep -q "evidence:" ".case-manual-tested" 2>/dev/null; then
    FAILURES+=("[FAIL] Manual testing marker has no evidence — was created with 'touch' instead of the mark script")
    FIXES+=("  FIX: Use playwright-cli to test, then: bash /Users/nicknisi/Developer/case/scripts/mark-manual-tested.sh")
  fi
fi

# Check 4: PR body has verification notes
# Extract --body content from the command
PR_BODY=$(echo "$COMMAND" | python3 -c "
import sys, re
cmd = sys.stdin.read()
# Match --body followed by quoted string or heredoc
m = re.search(r'--body\s+[\"'\''](.*?)[\"'\'']\s', cmd, re.DOTALL)
if not m:
    m = re.search(r'--body\s+\"(.*?)\"', cmd, re.DOTALL)
if not m:
    # Try heredoc pattern
    m = re.search(r'--body\s+\"\\\$\(cat <<.*?EOF(.*?)EOF', cmd, re.DOTALL)
if m:
    print(m.group(1))
else:
    print('')
" 2>/dev/null || echo "")

if [[ -n "$PR_BODY" ]]; then
  if ! echo "$PR_BODY" | grep -iq "verif\|tested\|test plan\|what was tested\|how it works"; then
    FAILURES+=("[FAIL] PR body missing verification notes")
    FIXES+=("  FIX: Add a '## Verification' section describing what you tested and how")
  fi
fi

# Report results
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  {
    echo ""
    echo "CASE PRE-PR CHECK FAILED"
    echo ""
    for i in "${!FAILURES[@]}"; do
      echo "${FAILURES[$i]}"
      echo "${FIXES[$i]}"
      echo ""
    done
    echo "Resolve all failures above, then retry gh pr create."
  } >&2
  exit 2
fi

# All checks passed
exit 0
