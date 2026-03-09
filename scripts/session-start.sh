#!/usr/bin/env bash
set -euo pipefail

# Session initialization script — gathers context, outputs structured JSON.
# Every agent runs this at the beginning of a new context window.
# Usage: session-start.sh [repo-path] [--task <task-json-path>]
# Output: structured JSON with session context

REPO_PATH="${1:-.}"
TASK_JSON=""

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) TASK_JSON="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Resolve to absolute path
REPO_PATH="$(cd "$REPO_PATH" && pwd)"

# Verify it's a git repo
if ! git -C "$REPO_PATH" rev-parse --git-dir > /dev/null 2>&1; then
  echo '{"error":"not a git repository: '"$REPO_PATH"'"}' >&2
  exit 1
fi

cd "$REPO_PATH"

# --- Gather git context ---
BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")
ON_MAIN="false"
if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
  ON_MAIN="true"
fi

LAST_COMMIT=$(git log --oneline -1 2>/dev/null || echo "")
UNCOMMITTED="false"
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  UNCOMMITTED="true"
fi

# Recent commits (last 5)
RECENT_COMMITS=$(git log --oneline -5 2>/dev/null || echo "")

# --- Gather evidence markers ---
CASE_TESTED="false"
CASE_MANUAL_TESTED="false"
CASE_REVIEWED="false"
CASE_ACTIVE="false"

[[ -f ".case-tested" ]] && CASE_TESTED="true"
[[ -f ".case-manual-tested" ]] && CASE_MANUAL_TESTED="true"
[[ -f ".case-reviewed" ]] && CASE_REVIEWED="true"
[[ -f ".case-active" ]] && CASE_ACTIVE="true"

# --- Gather environment ---
NODE_VERSION=$(node --version 2>/dev/null || echo "not found")
PNPM_VERSION=$(pnpm --version 2>/dev/null || echo "not found")

# --- Build JSON via node (reliable escaping) ---
node -e "
const path = process.argv[1];
const branch = process.argv[2];
const onMain = process.argv[3] === 'true';
const lastCommit = process.argv[4];
const uncommitted = process.argv[5] === 'true';
const recentRaw = process.argv[6];
const caseTested = process.argv[7] === 'true';
const caseManualTested = process.argv[8] === 'true';
const caseReviewed = process.argv[9] === 'true';
const caseActive = process.argv[10] === 'true';
const nodeVersion = process.argv[11];
const pnpmVersion = process.argv[12];
const taskJsonPath = process.argv[13];

const recent = recentRaw.split('\n').filter(Boolean);

const output = {
  repo: {
    path,
    branch,
    on_main: onMain,
    last_commit: lastCommit,
    uncommitted_changes: uncommitted,
    recent_commits: recent
  },
  task: null,
  evidence: {
    case_tested: caseTested,
    case_manual_tested: caseManualTested,
    case_reviewed: caseReviewed,
    case_active: caseActive
  },
  environment: {
    node_version: nodeVersion,
    pnpm_version: pnpmVersion
  }
};

// Parse task JSON if provided
if (taskJsonPath) {
  try {
    const fs = require('fs');
    const task = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
    output.task = {
      id: task.id || null,
      status: task.status || null,
      tested: task.tested || false,
      manual_tested: task.manualTested || false,
      agents: task.agents || {}
    };
  } catch (e) {
    output.task = { error: 'could not read task file: ' + e.message };
  }
}

console.log(JSON.stringify(output, null, 2));
" \
  "$REPO_PATH" \
  "$BRANCH" \
  "$ON_MAIN" \
  "$LAST_COMMIT" \
  "$UNCOMMITTED" \
  "$RECENT_COMMITS" \
  "$CASE_TESTED" \
  "$CASE_MANUAL_TESTED" \
  "$CASE_REVIEWED" \
  "$CASE_ACTIVE" \
  "$NODE_VERSION" \
  "$PNPM_VERSION" \
  "$TASK_JSON"
