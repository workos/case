# Implementation Spec: Harness Improvements - Phase 3

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Create a reviewer agent role (`agents/reviewer.md`) that sits between verifier and closer in the pipeline. The reviewer reads the git diff, checks it against golden principles and structured test output (from Phase 1), and produces structured findings. Critical findings block PR creation (via a `.case-reviewed` evidence marker). Advisory findings are posted as PR comments after the closer creates the PR.

This evolves the existing `ideation:reviewer` subagent type concept — the reviewer role definition tells the orchestrator when and how to invoke review, while the actual diff analysis can leverage the `ideation:reviewer` subagent for structured finding generation.

The reviewer introduces two enforcement points:
1. **Pre-PR gate**: `.case-reviewed` marker must exist (added to `pre-pr-check.sh`)
2. **Post-PR comments**: Findings posted via `gh api` after PR creation

## Feedback Strategy

**Inner-loop command**: `bash -n agents/reviewer.md` (syntax of shell snippets) and `bash -n scripts/mark-reviewed.sh`

**Playground**: Test suite — the scripts are validated by running them against a known diff.

**Why this approach**: The reviewer agent is primarily a role definition (markdown) plus a marker script (bash). The tightest loop is syntax-checking the scripts and dry-running the marker.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `agents/reviewer.md` | Reviewer agent role definition — reads diff, checks golden principles, produces findings |
| `scripts/mark-reviewed.sh` | Creates `.case-reviewed` evidence marker with review findings summary |

### Modified Files

| File Path | Changes |
| --- | --- |
| `hooks/pre-pr-check.sh` | Add Check 5: `.case-reviewed` marker must exist when `.case-active` is set |
| `agents/closer.md` | Add step to post review findings as PR comments after PR creation |

## Implementation Details

### agents/reviewer.md

**Pattern to follow**: `agents/verifier.md` (same structure — YAML frontmatter, Input section, Workflow with numbered steps, Rules section, AGENT_RESULT output)

**Overview**: The reviewer agent receives the same task context as other agents. It reads the diff, loads golden principles, and produces structured findings classified as critical (blocks PR), warning (advisory), or info (informational).

```yaml
---
name: reviewer
description: Code review agent for /case. Reads the diff against golden principles and structured test output. Produces findings that gate PR creation (critical) or inform via PR comments (warning/info). Never implements or tests.
tools: ["Read", "Bash", "Glob", "Grep"]
---
```

**Workflow**:

1. **Session Context** — Run `session-start.sh` (from Phase 2)
2. **Gather Context**:
   - Read the task file and task JSON
   - Read the git diff (`git diff main`)
   - Read `docs/golden-principles.md`
   - Read structured test output from `.case-tested` (Phase 1 format)
   - Read the target repo's `CLAUDE.md` for repo-specific conventions
3. **Review the Diff** — Check each changed file against:
   - Golden principles (all 17 invariants)
   - Repo-specific conventions from CLAUDE.md
   - File size limits (advisory at 300 lines, enforced at 500)
   - Conventional commit format on the branch's commits
   - Test coverage: did the implementer add/modify tests for changed src/ files?
   - Structured test output: any regressions (fail count > 0), coverage drops
4. **Classify Findings**:
   - `critical` — Blocks PR. Examples: tests failing, golden principle violation (enforced), secrets in diff, missing test for public API change
   - `warning` — Advisory. Examples: file approaching size limit, missing docstring on exported function, golden principle violation (advisory)
   - `info` — Informational. Examples: suggested refactoring, pattern recommendation
5. **Record**:
   - If no critical findings: run `mark-reviewed.sh` to create `.case-reviewed`
   - Append findings to task file Progress Log
   - Update task JSON agent phase
6. **Output** — AGENT_RESULT with findings array in summary

**Key decisions**:
- Reviewer does NOT fix code — it only flags issues. If critical findings exist, the orchestrator re-dispatches the implementer.
- Reviewer reads golden principles every time (they may have been updated by a retrospective)
- Critical findings include the specific principle violated and the file/line
- `.case-reviewed` is only created when 0 critical findings exist

**Implementation steps**:
1. Create `agents/reviewer.md` with YAML frontmatter matching the pattern
2. Write the full workflow following verifier.md's structure
3. Define the findings classification with examples
4. Include the AGENT_RESULT format with findings
5. Add Rules section

**Feedback loop**:
- **Playground**: Read the file and verify structure matches other agent files
- **Experiment**: Compare structure against `agents/verifier.md` — same sections, same AGENT_RESULT format, same rules patterns
- **Check command**: `head -5 agents/reviewer.md | grep -q "^name: reviewer" && echo "PASS" || echo "FAIL"`

### scripts/mark-reviewed.sh

**Pattern to follow**: `scripts/mark-tested.sh` and `scripts/mark-manual-tested.sh`

**Overview**: Creates `.case-reviewed` evidence marker. Accepts findings summary from stdin or arguments. Only callable when there are no critical findings (the reviewer agent enforces this before calling).

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: mark-reviewed.sh [--critical N] [--warnings N] [--info N]
# Reads optional detailed findings from stdin.
# Only creates .case-reviewed if --critical is 0 (or omitted).

CRITICAL=0
WARNINGS=0
INFO=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --critical) CRITICAL="$2"; shift 2 ;;
    --warnings) WARNINGS="$2"; shift 2 ;;
    --info) INFO="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ "$CRITICAL" -gt 0 ]]; then
  echo "ERROR: Cannot create .case-reviewed with $CRITICAL critical findings" >&2
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > .case-reviewed << EOF
timestamp: ${TIMESTAMP}
critical: ${CRITICAL}
warnings: ${WARNINGS}
info: ${INFO}
EOF

echo ".case-reviewed created (${WARNINGS} warnings, ${INFO} info)" >&2

# Update task JSON if .case-active present
CASE_REPO="/Users/nicknisi/Developer/case"
if [[ -f ".case-active" ]]; then
  TASK_ID=$(cat .case-active | tr -d '[:space:]')
  TASK_JSON="${CASE_REPO}/tasks/active/${TASK_ID}.task.json"
  if [[ -n "$TASK_ID" && -f "$TASK_JSON" ]]; then
    bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" agent reviewer status completed 2>/dev/null || true
    bash "${CASE_REPO}/scripts/task-status.sh" "$TASK_JSON" agent reviewer completed now 2>/dev/null || true
  fi
fi
```

**Key decisions**:
- Fails hard if `--critical > 0` — the reviewer agent must resolve critical findings before calling this
- Follows same task JSON update pattern as mark-tested.sh and mark-manual-tested.sh
- Simple key-value format matching `.case-tested` conventions

**Implementation steps**:
1. Create `scripts/mark-reviewed.sh`
2. Make executable
3. Test with 0 critical (should succeed)
4. Test with >0 critical (should fail)

**Feedback loop**:
- **Playground**: Run the script directly with various argument combinations
- **Experiment**: Test with `--critical 0 --warnings 2 --info 1` (should create marker), `--critical 1` (should fail), and no args (should create marker with all zeros)
- **Check command**: `bash scripts/mark-reviewed.sh --critical 0 --warnings 1 --info 2 && cat .case-reviewed && rm .case-reviewed`

### pre-pr-check.sh update

**Pattern to follow**: Existing Check 3 (manual testing conditional check)

**Overview**: Add Check 5 that requires `.case-reviewed` when `.case-active` is present.

Insert after the manual testing check block (after the `fi` closing Check 3):

```bash
# Check 5: Code review evidence (.case-reviewed marker)
if [[ ! -f ".case-reviewed" ]]; then
  FAILURES+=("[FAIL] Code review not done — .case-reviewed marker missing")
  FIXES+=("  FIX: Run the reviewer agent, then: bash /Users/nicknisi/Developer/case/scripts/mark-reviewed.sh --critical 0 --warnings N --info N")
elif ! grep -q "critical: 0" ".case-reviewed" 2>/dev/null; then
  FAILURES+=("[FAIL] Code review has unresolved critical findings")
  FIXES+=("  FIX: Address critical findings from the reviewer, then re-run the reviewer agent")
fi
```

**Key decisions**:
- Always required (not conditional like manual testing) — every PR should be reviewed
- Checks for `critical: 0` in the marker, not just file existence
- Placed after manual testing check to maintain logical ordering

**Implementation steps**:
1. Read current `hooks/pre-pr-check.sh`
2. Insert Check 5 block after Check 3's closing `fi`
3. Verify syntax with `bash -n`

### closer.md update

**Pattern to follow**: Existing Step 1 (Gather Context) reads evidence markers

**Overview**: Add two updates to closer.md:
1. In Step 1 (Gather Context): also read `.case-reviewed` for findings summary
2. Add Step 4.5 (Post Review Comments): after PR creation, post warning/info findings as a PR review comment

```markdown
### 4.5 Post Review Comments (if findings exist)

If the reviewer produced warnings or info findings, post them as a PR comment:

```bash
# Read findings from the reviewer's progress log entry
# Format as a comment
gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews \
  --method POST \
  -f body="## Code Review Findings

### Warnings
{list of warning findings}

### Info
{list of info findings}

_Automated review by case/reviewer agent_" \
  -f event="COMMENT"
```

Only post if there are actual findings to share. Skip this step if the reviewer had 0 warnings and 0 info.
```

**Implementation steps**:
1. Add `.case-reviewed` to the evidence reading list in Step 1
2. Add Step 4.5 after PR creation
3. Update the pre-flight checks to include `.case-reviewed`

## Testing Requirements

### Manual Testing

- [ ] `agents/reviewer.md` follows same structure as other agent files (YAML frontmatter, workflow, rules, AGENT_RESULT)
- [ ] `mark-reviewed.sh` creates `.case-reviewed` with correct format when critical=0
- [ ] `mark-reviewed.sh` exits 1 when critical > 0
- [ ] `pre-pr-check.sh` blocks PR when `.case-reviewed` is missing
- [ ] `pre-pr-check.sh` blocks PR when `.case-reviewed` has critical > 0
- [ ] `pre-pr-check.sh` passes when `.case-reviewed` has critical: 0
- [ ] `closer.md` references `.case-reviewed` in evidence gathering
- [ ] Task JSON status transitions work for reviewer agent phase

## Validation Commands

```bash
# Syntax check new/modified scripts
bash -n scripts/mark-reviewed.sh
bash -n hooks/pre-pr-check.sh

# Test mark-reviewed happy path
bash scripts/mark-reviewed.sh --critical 0 --warnings 2 --info 1
cat .case-reviewed
grep -q "critical: 0" .case-reviewed && echo "PASS" || echo "FAIL"
rm .case-reviewed

# Test mark-reviewed blocking
bash scripts/mark-reviewed.sh --critical 1 --warnings 0 --info 0 2>&1 || echo "Correctly blocked (exit $?)"

# Verify reviewer agent file structure
grep -q "^name: reviewer" agents/reviewer.md && echo "PASS: frontmatter" || echo "FAIL"
grep -q "AGENT_RESULT" agents/reviewer.md && echo "PASS: result block" || echo "FAIL"
grep -q "golden-principles" agents/reviewer.md && echo "PASS: principles ref" || echo "FAIL"

# Verify pre-pr-check has new gate
grep -q "case-reviewed" hooks/pre-pr-check.sh && echo "PASS: review gate added" || echo "FAIL"

# Verify closer references reviewer
grep -q "case-reviewed" agents/closer.md && echo "PASS: closer reads review" || echo "FAIL"
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
