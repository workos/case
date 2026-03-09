# Implementation Spec: Harness Improvements - Phase 4

**Contract**: ./contract.md
**Estimated Effort**: S

## Technical Approach

Create a `scripts/entropy-scan.sh` that wraps `check.sh` with structured JSON output and `/loop`-compatible behavior. The script must exit 0 (with status in output) so `/loop` doesn't treat non-zero exits as errors. Then add documentation describing the `/loop` workflow for entropy scanning during active sessions.

The Codex article describes continuous "garbage collection" that catches drift early. Since case is ad-hoc (no CI), `/loop` provides session-scoped continuous scanning — not persistent, but useful during active work sessions.

## Feedback Strategy

**Inner-loop command**: `bash scripts/entropy-scan.sh`

**Playground**: The script itself — run against available repos.

**Why this approach**: Shell script that wraps existing check.sh. Run it and verify JSON output.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `scripts/entropy-scan.sh` | `/loop`-compatible wrapper around `check.sh` — structured JSON output, always exits 0 |
| `docs/conventions/entropy-management.md` | Documents the `/loop` workflow for continuous convention scanning |

### Modified Files

| File Path | Changes |
| --- | --- |
| `docs/conventions/README.md` | Add entry for entropy-management.md |

## Implementation Details

### entropy-scan.sh

**Pattern to follow**: `scripts/check.sh` (wraps it, same CASE_DIR resolution)

**Overview**: Runs `check.sh` across all repos (or a specified repo), captures its output, and transforms it into structured JSON suitable for agent consumption. Always exits 0 so `/loop` doesn't stop the schedule on failures.

```bash
#!/usr/bin/env bash
set -uo pipefail
# Note: NOT set -e — we capture check.sh failures in the output

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET_REPO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) TARGET_REPO="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Run check.sh, capture output and exit code
ARGS=""
if [[ -n "$TARGET_REPO" ]]; then
  ARGS="--repo $TARGET_REPO"
fi

OUTPUT=$(bash "$CASE_DIR/scripts/check.sh" $ARGS 2>&1) || true
EXIT_CODE=$?

# Parse output for pass/fail counts
TOTAL_LINE=$(echo "$OUTPUT" | grep "^Summary:" || echo "Summary: 0/0")
PASSED=$(echo "$TOTAL_LINE" | grep -oE '[0-9]+/' | tr -d '/')
TOTAL=$(echo "$TOTAL_LINE" | grep -oE '/[0-9]+' | tr -d '/')
FAILED=$((TOTAL - PASSED))

# Extract individual failures
FAILURES=$(echo "$OUTPUT" | grep "\\[FAIL\\]" | sed 's/^  //' || echo "")

# Output structured JSON
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
node -e "
  const failures = $(echo "$FAILURES" | node -e "
    const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n').filter(Boolean);
    console.log(JSON.stringify(lines));
  ");
  console.log(JSON.stringify({
    timestamp: '$TIMESTAMP',
    status: $EXIT_CODE === 0 ? 'clean' : 'drift_detected',
    passed: ${PASSED:-0},
    failed: ${FAILED:-0},
    total: ${TOTAL:-0},
    failures: failures,
    repo_filter: '$TARGET_REPO' || null
  }, null, 2));
"

# Always exit 0 for /loop compatibility
exit 0
```

**Key decisions**:
- Always exits 0 — `/loop` treats non-zero as "stop the schedule"
- Status communicated via JSON `status` field (`clean` or `drift_detected`)
- Failures listed as an array for agent consumption
- Wraps `check.sh` rather than reimplementing — single source of truth for convention checks
- Uses node for JSON construction (consistent with other scripts)

**Implementation steps**:
1. Create `scripts/entropy-scan.sh`
2. Make executable
3. Test against available repos
4. Test with `--repo` flag for single-repo scanning

**Feedback loop**:
- **Playground**: Run against case's target repos (whatever is checked out locally)
- **Experiment**: Run with no args (all repos), with `--repo cli`, and with `--repo nonexistent`
- **Check command**: `bash scripts/entropy-scan.sh | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.status, d.passed + '/' + d.total)"`

### docs/conventions/entropy-management.md

**Overview**: Documents the entropy management workflow using `/loop` for session-scoped continuous scanning.

```markdown
# Entropy Management

Convention drift happens. Agent-generated code replicates existing patterns,
including suboptimal ones. Continuous scanning catches drift early.

## Quick Scan

Run a one-time scan across all repos:

```bash
bash scripts/entropy-scan.sh
```

Scan a specific repo:

```bash
bash scripts/entropy-scan.sh --repo cli
```

## Continuous Scanning with /loop

During active work sessions, use Claude Code's `/loop` to scan periodically:

```
/loop 30m bash scripts/entropy-scan.sh
```

This runs every 30 minutes while your session is active. The scan:
- Always exits 0 (won't break the loop)
- Reports status as JSON (`clean` or `drift_detected`)
- Lists specific failures for you to address

### Recommended intervals

| Scenario | Interval | Command |
| --- | --- | --- |
| Active multi-repo work | 30m | `/loop 30m bash scripts/entropy-scan.sh` |
| Focused single-repo work | 1h | `/loop 1h bash scripts/entropy-scan.sh --repo {name}` |
| Background monitoring | 2h | `/loop 2h bash scripts/entropy-scan.sh` |

### Limitations

- `/loop` is session-scoped — tasks stop when you close the terminal
- 3-day maximum expiry on recurring tasks
- No catch-up if Claude is busy when a scan is due
- For persistent scanning, consider GitHub Actions (future improvement)

## What Gets Checked

`entropy-scan.sh` wraps `check.sh`, which validates:

1. CLAUDE.md exists in each repo
2. Required commands in package.json
3. Conventional commits (last 10)
4. Source file sizes (< 500 lines)
5. package.json required fields

See `docs/golden-principles.md` for the full list of invariants.

## Acting on Drift

When drift is detected:
1. Read the failures array in the JSON output
2. Fix the lowest-effort issues first (commit format, missing fields)
3. For structural issues (file sizes, missing tests), create a task in `tasks/active/`
4. Run `check.sh --repo {name}` to verify fixes
```

**Implementation steps**:
1. Create `docs/conventions/entropy-management.md`
2. Update `docs/conventions/README.md` to include the new doc

### docs/conventions/README.md update

Add an entry for the new entropy management doc in the navigation table.

## Testing Requirements

### Manual Testing

- [ ] `entropy-scan.sh` outputs valid JSON
- [ ] `entropy-scan.sh` always exits 0, even when check.sh finds failures
- [ ] `entropy-scan.sh --repo <name>` filters to a single repo
- [ ] `entropy-scan.sh --repo <nonexistent>` outputs JSON with failure info (not crash)
- [ ] `/loop 1m bash scripts/entropy-scan.sh` runs successfully in a Claude Code session (manual test)
- [ ] `docs/conventions/entropy-management.md` is linked from README

## Validation Commands

```bash
# Syntax check
bash -n scripts/entropy-scan.sh

# Run and validate JSON
bash scripts/entropy-scan.sh | node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('Valid JSON')"

# Run with repo filter
bash scripts/entropy-scan.sh --repo cli | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('repo_filter:', d.repo_filter)"

# Verify always exits 0
bash scripts/entropy-scan.sh --repo nonexistent_repo; echo "Exit code: $?"

# Verify docs linked
grep -q "entropy-management" docs/conventions/README.md && echo "PASS" || echo "FAIL"
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
