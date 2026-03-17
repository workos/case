#!/usr/bin/env bash
# Append a learning entry to a repo's learnings file in the external repo.
# Creates the file with a standard header if it doesn't exist.
#
# Usage: write-learning.sh <repo-name> "<entry>"
#    or: echo "<entry>" | write-learning.sh <repo-name>
#
# Requires:
#   - gh CLI authenticated
#   - CASE_LEARNINGS_REPO env var set (e.g., 'youruser/case-learnings')

set -euo pipefail

if [[ -z "${CASE_LEARNINGS_REPO:-}" ]]; then
  echo "ERROR: CASE_LEARNINGS_REPO is not set." >&2
  echo "" >&2
  echo "This script writes per-repo learnings to a GitHub repo." >&2
  echo "Set CASE_LEARNINGS_REPO to your own GitHub repo (e.g., 'youruser/case-learnings')." >&2
  echo "" >&2
  echo "Setup:" >&2
  echo "  1. Create a GitHub repo for learnings (e.g., gh repo create case-learnings --public)" >&2
  echo "  2. Export the env var: export CASE_LEARNINGS_REPO='youruser/case-learnings'" >&2
  echo "  3. Or add it to your shell profile / Claude Code settings" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: write-learning.sh <repo-name> [entry]" >&2
  exit 1
fi

REPO_NAME="$1"
ENTRY="${2:-}"

# If no entry argument, read from stdin
if [[ -z "$ENTRY" ]]; then
  ENTRY=$(cat)
fi

if [[ -z "$ENTRY" ]]; then
  echo "ERROR: No entry provided. Pass as argument or pipe via stdin." >&2
  exit 1
fi

FILE_PATH="${REPO_NAME}.md"

# Fetch existing file for SHA (required by GitHub API for updates) and content
EXISTING_SHA=""
EXISTING_CONTENT=""

RESPONSE=$(gh api "repos/${CASE_LEARNINGS_REPO}/contents/${FILE_PATH}" 2>/dev/null) || true

if [[ -n "$RESPONSE" ]]; then
  EXISTING_SHA=$(echo "$RESPONSE" | gh api --input - --jq '.sha' 2>/dev/null || echo "$RESPONSE" | node -e "process.stdin.on('data',d=>{console.log(JSON.parse(d).sha||'')})" 2>/dev/null) || true
  ENCODED_CONTENT=$(echo "$RESPONSE" | gh api --input - --jq '.content' 2>/dev/null || echo "$RESPONSE" | node -e "process.stdin.on('data',d=>{console.log(JSON.parse(d).content||'')})" 2>/dev/null) || true
  if [[ -n "$ENCODED_CONTENT" ]]; then
    EXISTING_CONTENT=$(echo "$ENCODED_CONTENT" | base64 --decode 2>/dev/null || echo "$ENCODED_CONTENT" | base64 -d 2>/dev/null) || true
  fi
fi

# Build new content
if [[ -z "$EXISTING_CONTENT" ]]; then
  # Create new file with standard header
  DISPLAY_NAME=$(echo "$REPO_NAME" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')
  NEW_CONTENT="# ${DISPLAY_NAME} Learnings

Tactical knowledge from completed tasks. Read by agents before working in this repo.

<!-- Retrospective agent appends entries below. Do not edit existing entries. -->
${ENTRY}
"
else
  NEW_CONTENT="${EXISTING_CONTENT}${ENTRY}
"
fi

# Base64 encode the new content
ENCODED=$(printf '%s' "$NEW_CONTENT" | base64)

COMMIT_MSG="learnings(${REPO_NAME}): append entry"

# Write with retry for SHA conflicts (max 2 attempts)
MAX_RETRIES=2
ATTEMPT=0

while [[ $ATTEMPT -lt $MAX_RETRIES ]]; do
  ATTEMPT=$((ATTEMPT + 1))

  if [[ -n "$EXISTING_SHA" ]]; then
    # Update existing file
    if gh api "repos/${CASE_LEARNINGS_REPO}/contents/${FILE_PATH}" \
      --method PUT \
      -f message="$COMMIT_MSG" \
      -f content="$ENCODED" \
      -f sha="$EXISTING_SHA" \
      > /dev/null 2>&1; then
      echo "Appended learning to ${CASE_LEARNINGS_REPO}/${FILE_PATH}" >&2
      exit 0
    fi
  else
    # Create new file
    if gh api "repos/${CASE_LEARNINGS_REPO}/contents/${FILE_PATH}" \
      --method PUT \
      -f message="$COMMIT_MSG" \
      -f content="$ENCODED" \
      > /dev/null 2>&1; then
      echo "Created ${CASE_LEARNINGS_REPO}/${FILE_PATH} with learning entry" >&2
      exit 0
    fi
  fi

  # On failure, refresh SHA and retry
  if [[ $ATTEMPT -lt $MAX_RETRIES ]]; then
    echo "Write conflict, retrying (attempt $((ATTEMPT + 1))/${MAX_RETRIES})..." >&2
    EXISTING_SHA=$(gh api "repos/${CASE_LEARNINGS_REPO}/contents/${FILE_PATH}" --jq '.sha' 2>/dev/null) || true
  fi
done

echo "ERROR: Failed to write learning after ${MAX_RETRIES} attempts." >&2
exit 1
