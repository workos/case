#!/usr/bin/env bash
# snapshot-agent.sh — Snapshot an agent prompt before modification
#
# Usage:
#   snapshot-agent.sh <agent-name> --task <task-id> --reason "<why>"
#
# Creates:
#   docs/agent-versions/{agent}-{YYYY-MM-DD}.md  (copy of current prompt)
#   docs/agent-versions/changelog.jsonl           (append metadata entry)
#
# If a snapshot already exists for the same agent+date, appends a counter:
#   {agent}-{YYYY-MM-DD}-2.md, {agent}-{YYYY-MM-DD}-3.md, etc.

set -uo pipefail

AGENT_NAME="${1:-}"
shift || true

TASK_ID=""
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) TASK_ID="${2:-}"; shift 2 ;;
    --reason) REASON="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$AGENT_NAME" ]]; then
  echo "Usage: snapshot-agent.sh <agent-name> --task <task-id> --reason \"<why>\"" >&2
  exit 1
fi

CASE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_FILE="$CASE_ROOT/agents/${AGENT_NAME}.md"

# Phase 3: write snapshots into the data dir (XDG layout). The CLI sets
# CASE_DATA_DIR when invoking; otherwise we fall back to the XDG default,
# and finally to the legacy in-repo path for back-compat.
if [[ -n "${CASE_DATA_DIR:-}" ]]; then
  DATA_ROOT="$CASE_DATA_DIR"
elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
  DATA_ROOT="$XDG_CONFIG_HOME/case"
elif [[ -n "${HOME:-}" ]]; then
  DATA_ROOT="$HOME/.config/case"
else
  DATA_ROOT="$CASE_ROOT"
fi

VERSIONS_DIR="$DATA_ROOT/agent-versions"
# Legacy: keep using docs/agent-versions when it already exists in the repo.
if [[ ! -d "$VERSIONS_DIR" ]] && [[ -d "$CASE_ROOT/docs/agent-versions" ]]; then
  VERSIONS_DIR="$CASE_ROOT/docs/agent-versions"
fi
mkdir -p "$VERSIONS_DIR"
CHANGELOG="$VERSIONS_DIR/changelog.jsonl"

if [[ ! -f "$AGENT_FILE" ]]; then
  echo "Error: agent file not found: $AGENT_FILE" >&2
  exit 1
fi

DATE=$(date -u +%Y-%m-%d)

# Determine snapshot filename (handle same-day duplicates)
SNAP_BASE="${AGENT_NAME}-${DATE}"
SNAP_FILE="$VERSIONS_DIR/${SNAP_BASE}.md"
if [[ -f "$SNAP_FILE" ]]; then
  COUNTER=2
  while [[ -f "$VERSIONS_DIR/${SNAP_BASE}-${COUNTER}.md" ]]; do
    COUNTER=$((COUNTER + 1))
  done
  SNAP_FILE="$VERSIONS_DIR/${SNAP_BASE}-${COUNTER}.md"
  VERSION_TAG="${SNAP_BASE}-${COUNTER}"
else
  VERSION_TAG="$SNAP_BASE"
fi

# Copy the current prompt
cp "$AGENT_FILE" "$SNAP_FILE"

# Compute SHA-256 of the agent prompt for content-based dedup
CONTENT_HASH=$(shasum -a 256 "$AGENT_FILE" | cut -d' ' -f1 | head -c 16)

# Append to changelog
AGENT="$AGENT_NAME" VER="$VERSION_TAG" TASK="$TASK_ID" RSN="$REASON" HASH="$CONTENT_HASH" \
  SNAPDIR="$VERSIONS_DIR" python3 -c "
import json, os
from datetime import datetime, timezone

entry = {
    'version': os.environ['VER'],
    'agent': os.environ['AGENT'],
    'date': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'task': os.environ['TASK'] or None,
    'reason': os.environ['RSN'] or None,
    'contentHash': os.environ['HASH'],
    'snapshotFile': os.path.join(os.environ['SNAPDIR'], os.environ['VER'] + '.md'),
}

print(json.dumps(entry, separators=(',', ':')))
" >> "$CHANGELOG"

echo "OK: snapshot ${VERSION_TAG} → $(basename "$SNAP_FILE") (hash: ${CONTENT_HASH})"
