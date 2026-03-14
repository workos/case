#!/usr/bin/env bash
set -euo pipefail

# Per-repo readiness verification
# Verifies a repo is ready for agent work: deps installed, tests pass, build works.
# Usage: bootstrap.sh <repo-name>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECTS_JSON="$CASE_DIR/projects.json"

if [[ $# -lt 1 ]]; then
  echo "Usage: bootstrap.sh <repo-name>" >&2
  echo "Available repos:" >&2
  node -e "const p=require('$PROJECTS_JSON'); p.repos.forEach(r => console.log('  ' + r.name));" >&2
  exit 1
fi

REPO_NAME="$1"

# --- Look up repo in projects.json ---
REPO_INFO=$(node -e "
  const p = require('$PROJECTS_JSON');
  const r = p.repos.find(r => r.name === '$REPO_NAME');
  if (!r) { console.log('NOT_FOUND'); process.exit(0); }
  console.log(JSON.stringify(r));
")

if [[ "$REPO_INFO" == "NOT_FOUND" ]]; then
  echo "Error: repo '$REPO_NAME' not found in projects.json" >&2
  echo "Available repos:" >&2
  node -e "const p=require('$PROJECTS_JSON'); p.repos.forEach(r => console.log('  ' + r.name));" >&2
  exit 1
fi

REPO_PATH_RAW=$(node -e "console.log(JSON.parse(process.argv[1]).path)" "$REPO_INFO")
REPO_PATH=$(cd "$CASE_DIR" && cd "$REPO_PATH_RAW" 2>/dev/null && pwd)

if [[ ! -d "$REPO_PATH" ]]; then
  echo "Error: repo directory not found at $REPO_PATH_RAW (resolved from $CASE_DIR)" >&2
  exit 1
fi

get_command() {
  local cmd_name="$1"
  node -e "const r=JSON.parse(process.argv[1]); console.log((r.commands && r.commands['$cmd_name']) || '')" "$REPO_INFO"
}

# --- Run a step with timing ---
TOTAL_TIME=0
ALL_OK=true

run_step() {
  local label="$1"
  local cmd="$2"

  if [[ -z "$cmd" ]]; then
    return
  fi

  local start_time end_time elapsed
  start_time=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')

  if (cd "$REPO_PATH" && eval "$cmd" > /tmp/bootstrap_output_$$ 2>&1); then
    end_time=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
    elapsed=$(( (end_time - start_time) / 1000000 ))
    local secs=$(node -e "console.log(($elapsed/1000).toFixed(1))")
    echo "  [OK] $label (${secs}s)"
    TOTAL_TIME=$((TOTAL_TIME + elapsed))
  else
    end_time=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
    elapsed=$(( (end_time - start_time) / 1000000 ))
    local secs=$(node -e "console.log(($elapsed/1000).toFixed(1))")
    echo "  [FAIL] $label (${secs}s)"
    echo "         Output (last 10 lines):"
    tail -10 /tmp/bootstrap_output_$$ | sed 's/^/         /'
    TOTAL_TIME=$((TOTAL_TIME + elapsed))
    ALL_OK=false
  fi

  rm -f /tmp/bootstrap_output_$$
}

# --- Ensure .case-* files are in .gitignore ---
GITIGNORE="$REPO_PATH/.gitignore"
if [[ -f "$GITIGNORE" ]]; then
  if ! grep -q '\.case-\*' "$GITIGNORE" 2>/dev/null; then
    printf '\n# Case harness markers (auto-added by bootstrap)\n.case-*\n' >> "$GITIGNORE"
    echo "  [INFO] Added .case-* to .gitignore"
  fi
fi

# --- Main ---
echo "Bootstrapping $REPO_NAME ($REPO_PATH_RAW)..."

SETUP_CMD=$(get_command "setup")
TEST_CMD=$(get_command "test")
BUILD_CMD=$(get_command "build")

run_step "setup: $SETUP_CMD" "$SETUP_CMD"

if [[ "$ALL_OK" == false ]]; then
  echo "Setup failed. Cannot continue."
  exit 1
fi

run_step "test: $TEST_CMD" "$TEST_CMD"
run_step "build: $BUILD_CMD" "$BUILD_CMD"

# --- Summary ---
TOTAL_SECS=$(node -e "console.log(($TOTAL_TIME/1000).toFixed(1))")

if [[ "$ALL_OK" == true ]]; then
  echo "Ready. Total: ${TOTAL_SECS}s"
  exit 0
else
  echo "Not ready. Total: ${TOTAL_SECS}s"
  exit 1
fi
