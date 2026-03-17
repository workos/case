#!/usr/bin/env bash
# Read a repo's learnings file from the external learnings repo.
# Outputs the file content to stdout. If no file exists, outputs nothing.
#
# Usage: read-learning.sh <repo-name>
#
# Requires:
#   - gh CLI authenticated
#   - CASE_LEARNINGS_REPO env var set (e.g., 'youruser/case-learnings')

set -euo pipefail

if [[ -z "${CASE_LEARNINGS_REPO:-}" ]]; then
  echo "ERROR: CASE_LEARNINGS_REPO is not set." >&2
  echo "" >&2
  echo "This script reads per-repo learnings from a GitHub repo." >&2
  echo "Set CASE_LEARNINGS_REPO to your own GitHub repo (e.g., 'youruser/case-learnings')." >&2
  echo "" >&2
  echo "Setup:" >&2
  echo "  1. Create a GitHub repo for learnings (e.g., gh repo create case-learnings --public)" >&2
  echo "  2. Export the env var: export CASE_LEARNINGS_REPO='youruser/case-learnings'" >&2
  echo "  3. Or add it to your shell profile / Claude Code settings" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: read-learning.sh <repo-name>" >&2
  exit 1
fi

REPO_NAME="$1"
FILE_PATH="${REPO_NAME}.md"

# Fetch file content via GitHub API (base64-encoded).
# If the file doesn't exist (404), output nothing.
CONTENT=$(gh api "repos/${CASE_LEARNINGS_REPO}/contents/${FILE_PATH}" --jq '.content' 2>/dev/null) || true

if [[ -z "$CONTENT" ]]; then
  echo "No learnings file found for ${REPO_NAME} in ${CASE_LEARNINGS_REPO}." >&2
  exit 0
fi

# Decode base64 (macOS uses --decode, Linux uses -d)
echo "$CONTENT" | base64 --decode 2>/dev/null || echo "$CONTENT" | base64 -d
