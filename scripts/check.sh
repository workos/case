#!/usr/bin/env bash
set -euo pipefail

# Cross-repo convention enforcement
# Reads projects.json and checks each repo against golden principles.
# Usage: check.sh [--repo <name>] [--run-tests]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECTS_JSON="$CASE_DIR/projects.json"

# --- Flags ---
TARGET_REPO=""
RUN_TESTS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      TARGET_REPO="$2"
      shift 2
      ;;
    --run-tests)
      RUN_TESTS=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: check.sh [--repo <name>] [--run-tests]" >&2
      exit 1
      ;;
  esac
done

# --- Parse projects.json ---
REPO_COUNT=$(node -e "const p=require('$PROJECTS_JSON'); console.log(p.repos.length)")
TOTAL_PASS=0
TOTAL_CHECKS=0

get_repo_field() {
  local idx="$1" field="$2"
  node -e "const p=require('$PROJECTS_JSON'); console.log(p.repos[$idx].$field || '')"
}

get_repo_command() {
  local idx="$1" cmd="$2"
  node -e "const p=require('$PROJECTS_JSON'); console.log((p.repos[$idx].commands && p.repos[$idx].commands['$cmd']) || '')"
}

# --- Check functions ---
# Each prints [PASS] or [FAIL] and increments counters.

check_claude_md() {
  local repo_path="$1"
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  if [[ -f "$repo_path/CLAUDE.md" ]] || [[ -f "$repo_path/CLAUDE.local.md" ]]; then
    echo "  [PASS] CLAUDE.md or CLAUDE.local.md exists"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo "  [FAIL] CLAUDE.md or CLAUDE.local.md exists"
    echo "         FIX: Create a CLAUDE.md file in the repo root. See docs/golden-principles.md"
  fi
}

check_required_commands() {
  local repo_path="$1" idx="$2"
  local required_cmds=("test")
  local missing=()

  # Check which commands exist in package.json scripts
  for cmd in "${required_cmds[@]}"; do
    local has_cmd
    has_cmd=$(node -e "const p=require('$repo_path/package.json'); console.log(p.scripts && p.scripts['$cmd'] ? 'yes' : 'no')")
    if [[ "$has_cmd" != "yes" ]]; then
      missing+=("$cmd")
    fi
  done

  # Also check the commands declared in projects.json are present
  local declared_cmds
  declared_cmds=$(node -e "
    const p=require('$PROJECTS_JSON');
    const cmds = p.repos[$idx].commands || {};
    const keys = Object.keys(cmds).filter(k => k !== 'setup');
    console.log(keys.join(' '));
  ")

  for cmd in $declared_cmds; do
    local has_cmd
    has_cmd=$(node -e "const p=require('$repo_path/package.json'); const s=p.scripts||{}; console.log(Object.keys(s).some(k => k === '$cmd') ? 'yes' : 'no')")
    if [[ "$has_cmd" != "yes" ]]; then
      # The command in projects.json may be "pnpm run X" — extract X
      local actual_script
      actual_script=$(node -e "
        const p=require('$PROJECTS_JSON');
        const raw = (p.repos[$idx].commands || {})['$cmd'] || '';
        const m = raw.match(/pnpm\s+(?:run\s+)?(\S+)/);
        console.log(m ? m[1] : '$cmd');
      ")
      has_cmd=$(node -e "const p=require('$repo_path/package.json'); const s=p.scripts||{}; console.log(s['$actual_script'] ? 'yes' : 'no')")
      if [[ "$has_cmd" != "yes" ]]; then
        missing+=("$cmd")
      fi
    fi
  done

  # Deduplicate missing
  local unique_missing
  unique_missing=$(printf '%s\n' "${missing[@]}" 2>/dev/null | sort -u | tr '\n' ' ')

  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  if [[ -z "${unique_missing// /}" ]]; then
    echo "  [PASS] Required commands exist in package.json"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo "  [FAIL] Required commands exist in package.json"
    echo "         FIX: Add missing scripts to package.json: $unique_missing"
  fi
}

check_conventional_commits() {
  local repo_path="$1"
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

  local bad_commits=""
  local cc_regex='^[a-f0-9]+ (feat|fix|chore|refactor|docs|test|ci|perf|build|style|revert)(\(.+\))?!?:'

  while IFS= read -r line; do
    if [[ -z "$line" ]]; then
      continue
    fi
    if ! echo "$line" | grep -qE "$cc_regex"; then
      bad_commits="${bad_commits}    - ${line}\n"
    fi
  done < <(cd "$repo_path" && git log --oneline -10 2>/dev/null)

  if [[ -z "$bad_commits" ]]; then
    echo "  [PASS] Conventional commits (last 10)"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo "  [FAIL] Conventional commits (last 10)"
    echo -e "         Non-conforming commits:\n${bad_commits}         FIX: Use conventional commit format: type(scope): description"
  fi
}

check_file_sizes() {
  local repo_path="$1"
  local max_lines=500
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

  local oversized=""
  if [[ -d "$repo_path/src" ]]; then
    while IFS= read -r file; do
      if [[ -f "$file" ]]; then
        local lines
        lines=$(wc -l < "$file" | tr -d ' ')
        if [[ "$lines" -gt "$max_lines" ]]; then
          local relpath="${file#$repo_path/}"
          oversized="${oversized}    - ${relpath} (${lines} lines)\n"
        fi
      fi
    done < <(find "$repo_path/src" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) ! -name '*.test.*' ! -name '*.spec.*' ! -path '*/test/*' ! -path '*/__tests__/*')
  fi

  if [[ -z "$oversized" ]]; then
    echo "  [PASS] No source files over ${max_lines} lines in src/"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo "  [FAIL] File size limit exceeded in src/"
    echo -e "         Oversized files:\n${oversized}         FIX: Split into smaller modules. See docs/golden-principles.md #9"
  fi
}

check_package_json_fields() {
  local repo_path="$1"
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

  local missing
  missing=$(node -e "
    const p = require('$repo_path/package.json');
    const required = ['name', 'version', 'description', 'license'];
    const missing = required.filter(f => !p[f]);
    console.log(missing.join(', '));
  ")

  if [[ -z "$missing" ]]; then
    echo "  [PASS] package.json has required fields (name, version, description, license)"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo "  [FAIL] package.json missing fields: $missing"
    echo "         FIX: Add missing fields to package.json"
  fi
}

check_run_tests() {
  local repo_path="$1" idx="$2"
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

  local test_cmd
  test_cmd=$(get_repo_command "$idx" "test")
  if [[ -z "$test_cmd" ]]; then
    echo "  [SKIP] No test command defined"
    return
  fi

  if (cd "$repo_path" && eval "$test_cmd" > /dev/null 2>&1); then
    echo "  [PASS] Tests pass ($test_cmd)"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo "  [FAIL] Tests fail ($test_cmd)"
    echo "         FIX: Run '$test_cmd' locally and fix failures"
  fi
}

# --- Main loop ---
REPO_NAMES_PROCESSED=0

for ((i=0; i<REPO_COUNT; i++)); do
  name=$(get_repo_field "$i" "name")
  path_raw=$(get_repo_field "$i" "path")

  # Skip if --repo is set and doesn't match
  if [[ -n "$TARGET_REPO" ]] && [[ "$name" != "$TARGET_REPO" ]]; then
    continue
  fi

  # Resolve path relative to case dir
  repo_path=$(cd "$CASE_DIR" && cd "$path_raw" 2>/dev/null && pwd)
  if [[ ! -d "$repo_path" ]]; then
    echo "=== $name ($path_raw) ==="
    echo "  [SKIP] Repo not found at $path_raw"
    echo ""
    continue
  fi

  REPO_NAMES_PROCESSED=$((REPO_NAMES_PROCESSED + 1))
  echo "=== $name ($path_raw) ==="

  check_claude_md "$repo_path"
  check_required_commands "$repo_path" "$i"
  check_conventional_commits "$repo_path"
  check_file_sizes "$repo_path"
  check_package_json_fields "$repo_path"

  if [[ "$RUN_TESTS" == true ]]; then
    check_run_tests "$repo_path" "$i"
  fi

  echo ""
done

if [[ -n "$TARGET_REPO" ]] && [[ "$REPO_NAMES_PROCESSED" -eq 0 ]]; then
  echo "Error: repo '$TARGET_REPO' not found in projects.json" >&2
  exit 1
fi

# --- Summary ---
echo "Summary: ${TOTAL_PASS}/${TOTAL_CHECKS} checks passed across ${REPO_NAMES_PROCESSED} repos"

if [[ "$TOTAL_PASS" -lt "$TOTAL_CHECKS" ]]; then
  exit 1
fi

exit 0
