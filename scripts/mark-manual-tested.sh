#!/usr/bin/env bash
# Create .case-manual-tested marker with evidence that playwright-cli was used.
# The pre-PR hook checks this file contains real playwright evidence.
#
# Usage: bash /path/to/mark-manual-tested.sh
#
# Checks for evidence that playwright-cli was actually used in this directory:
# - .playwright-cli/ directory with recent screenshots
# - /tmp/*.png files created recently (screenshots)
# If no evidence found, refuses to create the marker.

set -euo pipefail

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EVIDENCE_FOUND=false
EVIDENCE_DETAILS=""

# Check for .playwright-cli directory with recent files
if [[ -d ".playwright-cli" ]]; then
  RECENT_FILES=$(find .playwright-cli -name "*.png" -mmin -60 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$RECENT_FILES" -gt 0 ]]; then
    EVIDENCE_FOUND=true
    EVIDENCE_DETAILS="playwright-cli screenshots: ${RECENT_FILES} files in .playwright-cli/ (last hour)"
  fi
fi

# Check for recent screenshots in /tmp
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

cat > .case-manual-tested << EOF
timestamp: ${TIMESTAMP}
evidence: ${EVIDENCE_DETAILS}
EOF

echo ".case-manual-tested created (${EVIDENCE_DETAILS})" >&2
