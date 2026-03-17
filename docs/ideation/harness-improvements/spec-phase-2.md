# Implementation Spec: Harness Improvements - Phase 2

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Create a `scripts/session-start.sh` that every agent runs at the beginning of a new context window. It gathers git state, task status, environment info, and a quick test baseline, outputting structured JSON that agents can consume immediately. Then update all 4 agent role files (implementer, verifier, closer, retrospective) to reference this script in their setup steps.

The Anthropic article identified this as the single highest-leverage intervention — it eliminates redundant discovery work and saves tokens in every session. The key insight: agents shouldn't spend their first 500 tokens figuring out what branch they're on and what task they're working on.

## Feedback Strategy

**Inner-loop command**: `bash scripts/session-start.sh ${CASE_REPO}`

**Playground**: The script itself — run it against the case repo and inspect output.

**Why this approach**: This is a standalone shell script. Running it and checking JSON output is the tightest loop.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `scripts/session-start.sh` | Session initialization script — gathers context, outputs structured JSON |

### Modified Files

| File Path | Changes |
| --- | --- |
| `agents/implementer.md` | Add session-start as step 0 in Setup workflow |
| `agents/verifier.md` | Add session-start as step 0 in Assess workflow |
| `agents/closer.md` | Add session-start as step 0 in Gather Context workflow |
| `agents/retrospective.md` | Add session-start as step 0 in Read the Full Record workflow |

## Implementation Details

### session-start.sh

**Pattern to follow**: `scripts/check.sh` (same style — bash, set -euo pipefail, argument parsing, structured output)

**Overview**: Gathers context from the current working directory and any active task, outputting a JSON object that agents can parse or simply read as context.

```bash
#!/usr/bin/env bash
set -euo pipefail

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

cd "$REPO_PATH"
```

**Output structure**:
```json
{
  "repo": {
    "path": "/abs/path",
    "branch": "fix/issue-123",
    "on_main": false,
    "last_commit": "abc1234 fix(auth): handle expired tokens",
    "uncommitted_changes": true,
    "recent_commits": ["abc1234 fix...", "def5678 feat..."]
  },
  "task": {
    "id": "authkit-nextjs-1-issue-364",
    "status": "implementing",
    "tested": false,
    "manual_tested": false,
    "agents": {
      "implementer": "completed",
      "verifier": "pending"
    }
  },
  "evidence": {
    "case_tested": true,
    "case_manual_tested": false,
    "case_active": true
  },
  "environment": {
    "node_version": "v20.11.0",
    "pnpm_version": "9.1.0"
  }
}
```

**Key decisions**:
- Output JSON (not YAML or plain text) so agents can parse it programmatically if needed
- Use node for JSON construction (reliable escaping, available everywhere)
- Task context is optional — works without `--task` flag for ad-hoc use
- Evidence marker detection is automatic (checks for `.case-*` files in cwd)
- Non-destructive — only reads, never writes

**Implementation steps**:
1. Create script with argument parsing (repo path, optional --task)
2. Gather git context: branch, last 5 commits, uncommitted changes, on-main check
3. Gather evidence: check for `.case-tested`, `.case-manual-tested`, `.case-active`
4. If `--task` provided, parse task JSON for status, agents, tested flags
5. Gather environment: node version, pnpm version
6. Output as JSON via node

**Feedback loop**:
- **Playground**: Run against the case repo itself (it's a git repo with known state)
- **Experiment**: Run with no args (default cwd), with explicit repo path, with `--task` pointing to an existing task JSON, and with `--task` pointing to a nonexistent file
- **Check command**: `bash scripts/session-start.sh . | node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))" && echo "Valid JSON"`

### Agent role updates

**Pattern to follow**: Each agent's existing "Step 1" in their workflow section.

**Overview**: Add a "Step 0: Session Context" before the existing first step in each agent role. The step runs `session-start.sh` and reads the output to orient the agent.

For each agent file, insert before the existing first numbered step:

```markdown
### 0. Session Context

Run the session-start script to orient yourself:
```bash
SESSION=$(bash ${CASE_REPO}/scripts/session-start.sh <target-repo-path> --task <task.json>)
echo "$SESSION"
```

Read the output to understand: current branch, last commits, task status, which agents have run, and what evidence exists. This replaces manual git log / task file discovery.
```

**Key decisions**:
- Step 0 (not renumbering existing steps) to minimize diff and preserve existing playbook references
- Same script call across all roles — the output is role-agnostic context
- Agents read the output but aren't required to parse it programmatically (it's human-readable JSON too)

**Implementation steps**:
1. Edit `agents/implementer.md` — insert Step 0 before "### 1. Setup"
2. Edit `agents/verifier.md` — insert Step 0 before "### 1. Assess"
3. Edit `agents/closer.md` — insert Step 0 before "### 1. Gather Context"
4. Edit `agents/retrospective.md` — insert Step 0 before "### 1. Read the Full Record"

## Testing Requirements

### Manual Testing

- [ ] `session-start.sh` runs without error in a git repo
- [ ] `session-start.sh` outputs valid JSON
- [ ] `session-start.sh` correctly detects branch, commits, evidence markers
- [ ] `session-start.sh --task <path>` includes task context
- [ ] `session-start.sh --task <nonexistent>` gracefully omits task context
- [ ] `session-start.sh` in a non-git directory fails gracefully
- [ ] All 4 agent role files reference session-start in Step 0

## Validation Commands

```bash
# Syntax check
bash -n scripts/session-start.sh

# Run against case repo
bash scripts/session-start.sh ${CASE_REPO}

# Validate JSON output
bash scripts/session-start.sh . | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('branch:', d.repo.branch); console.log('Valid JSON: true')"

# Run with task
bash scripts/session-start.sh . --task ${CASE_REPO}/tasks/active/authkit-nextjs-1-issue-364-proxy-support.task.json

# Verify agent files were updated
for f in agents/implementer.md agents/verifier.md agents/closer.md agents/retrospective.md; do
  grep -q "session-start" "$f" && echo "PASS: $f" || echo "FAIL: $f"
done
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
