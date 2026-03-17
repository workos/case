# Implementation Spec: Case Multi-Agent - Phase 1

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 1 establishes the task infrastructure that all four agents (orchestrator, implementer, verifier, closer) depend on. The core change is a hybrid task format: Markdown for human-readable content + a JSON companion file for machine-touched fields. This replaces the fragile directory-move lifecycle (`active/` → `done/`) with status fields in JSON.

The JSON companion stores structured metadata (status, timestamps, agent phases, test evidence flags) while the Markdown file retains the human-readable task description, acceptance criteria, checklist, and a new **progress log** section that agents append to.

Scripts and hooks are updated to read/write the JSON companion instead of moving files between directories.

## Feedback Strategy

**Inner-loop command**: `bash scripts/task-status.sh tasks/active/test-task.task.json status`

**Playground**: Shell script testing — create a test task file pair, run scripts against it, verify JSON fields update correctly.

**Why this approach**: Most changes are to shell scripts and structured data files. The tightest loop is running the scripts with test inputs and checking output.

## File Changes

### New Files

| File Path | Purpose |
|-----------|---------|
| `tasks/task.schema.json` | JSON Schema for `.task.json` companion files |
| `scripts/task-status.sh` | Read/update task JSON fields (status, agent phases, flags) |

### Modified Files

| File Path | Changes |
|-----------|---------|
| `tasks/README.md` | Document new hybrid format (Markdown + JSON companion), status lifecycle, progress log section |
| `tasks/templates/bug-fix.md` | Add `## Progress Log` section, update checklist references |
| `tasks/templates/cli-command.md` | Add `## Progress Log` section |
| `tasks/templates/authkit-framework.md` | Add `## Progress Log` section |
| `tasks/templates/cross-repo-update.md` | Add `## Progress Log` section |
| `hooks/post-pr-cleanup.sh` | Update status in JSON companion instead of moving files; still clean up marker files |
| `scripts/mark-tested.sh` | Add: read `.case-active` for task ID, update `.task.json` `tested` → `true` via `task-status.sh` |
| `scripts/mark-manual-tested.sh` | Add: read `.case-active` for task ID, update `.task.json` `manualTested` → `true` via `task-status.sh` |

## Implementation Details

### Task JSON Schema

**Pattern to follow**: `projects.schema.json` (existing JSON Schema in the repo)

**Overview**: Define the structure for `.task.json` companion files. The schema defines field types and allowed values. State-transition enforcement lives in `task-status.sh`, not in the schema — JSON Schema can't enforce cross-write transition history.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Case Task",
  "type": "object",
  "required": ["id", "status", "created", "repo"],
  "properties": {
    "id": { "type": "string", "description": "Task slug matching the .md filename, e.g. authkit-nextjs-1-issue-53" },
    "status": {
      "enum": ["active", "implementing", "verifying", "closing", "pr-opened", "merged"]
    },
    "created": { "type": "string", "format": "date-time" },
    "repo": { "type": "string" },
    "issue": { "type": "string" },
    "issueType": { "enum": ["github", "linear", "freeform"] },
    "branch": { "type": "string" },
    "agents": {
      "type": "object",
      "properties": {
        "orchestrator": { "$ref": "#/$defs/agentPhase" },
        "implementer": { "$ref": "#/$defs/agentPhase" },
        "verifier": { "$ref": "#/$defs/agentPhase" },
        "closer": { "$ref": "#/$defs/agentPhase" }
      }
    },
    "tested": { "type": "boolean", "default": false },
    "manualTested": { "type": "boolean", "default": false },
    "prUrl": { "type": ["string", "null"], "default": null },
    "prNumber": { "type": ["integer", "null"], "default": null }
  },
  "$defs": {
    "agentPhase": {
      "type": "object",
      "properties": {
        "started": { "type": ["string", "null"], "format": "date-time" },
        "completed": { "type": ["string", "null"], "format": "date-time" },
        "status": { "enum": ["pending", "running", "completed", "failed"] }
      }
    }
  }
}
```

**Key decisions**:

- **`id` field is required** — the task slug (e.g., `authkit-nextjs-1-issue-53`) serves as the deterministic key for targeting specific tasks. Hooks and scripts use this to operate on the correct task, not "all tasks in active/."
- Status enum covers the full lifecycle. `merged` is set manually or by future automation — not by agents.
- **State transition enforcement is in `task-status.sh`**, not the schema. The script validates that transitions follow the allowed graph (see below). JSON Schema only validates structure.
- Agent phase tracking is optional (agents that existed before multi-agent won't have it). The `agents` field is not required.
- `tested` and `manualTested` are boolean flags flipped by marker scripts. Evidence details remain in the marker files themselves.
- **Field naming**: all JSON fields use camelCase (`prUrl`, `manualTested`, `issueType`). CLI arguments to `task-status.sh` also use camelCase to match — no kebab-case aliases. One canonical name per field.

**Implementation steps**:

1. Read `projects.schema.json` to understand existing JSON Schema conventions in the repo
2. Create `tasks/task.schema.json` with the schema above
3. Validate the schema is valid JSON: `python3 -c "import json; json.load(open('tasks/task.schema.json'))"`

### Task Status Script

**Overview**: Shell script to read and update fields in `.task.json` companion files. Used by hooks, agents, and other scripts to manage task lifecycle without manual JSON editing.

```bash
#!/usr/bin/env bash
# Usage:
#   task-status.sh <task.json> status                          # read status
#   task-status.sh <task.json> status implementing             # set status (validates transition)
#   task-status.sh <task.json> agent orchestrator started      # set agent phase
#   task-status.sh <task.json> prUrl <url>                     # set PR URL
#   task-status.sh <task.json> id                              # read task id
#   task-status.sh <task.json> tested true --from-marker       # ONLY callable by marker scripts
#   task-status.sh <task.json> manualTested true --from-marker # ONLY callable by marker scripts
#
# Note: tested and manualTested reject writes without --from-marker.
# These fields are owned by mark-tested.sh and mark-manual-tested.sh.
```

**Key decisions**:

- Uses `python3 -c` for JSON manipulation (available on macOS, no external deps). Avoids `jq` dependency.
- Read operations output the value to stdout. Write operations modify the file in place.
- Validates that the JSON file exists before operating. Fails with clear error if not found.
- **CLI field names match JSON field names exactly** — `prUrl` not `pr-url`, `manualTested` not `manual-tested`. One canonical name, no aliases.
- **Status transitions are validated**. The script rejects invalid transitions with a clear error. Allowed transitions:

```
active → implementing
implementing → verifying
verifying → closing
closing → pr-opened
pr-opened → pr-opened       (idempotent — hook may re-fire)
pr-opened → merged
# Recovery transitions:
implementing → active      (restart after failure)
verifying → implementing   (fix-and-retry)
closing → verifying        (hook failure, re-verify)
```

**Implementation steps**:

1. Create `scripts/task-status.sh` with the interface above
2. Implement read mode: parse JSON, output requested field
3. Implement write mode: parse JSON, update field, write back
4. **Implement transition validation**: when setting `status`, read current status, check against allowed transitions map, reject with error if invalid
5. Implement agent phase mode: update `agents.{name}.{field}` with ISO timestamp
6. Make executable: `chmod +x scripts/task-status.sh`
7. Test: create a temporary `.task.json`, run read/write operations, verify
8. Test: attempt invalid transition (e.g., `active` → `pr-opened`), verify it fails

**Feedback loop**:

- **Playground**: Create a test `.task.json` file with default values, run script commands against it
- **Experiment**: Test all operations: read status, set status, set agent phase, set tested flag, set PR URL. Test error cases: missing file, invalid field name, invalid status value.
- **Check command**: `bash scripts/task-status.sh /tmp/test-task.task.json status`

### Updated Task README

**Pattern to follow**: Current `tasks/README.md`

**Overview**: Document the new hybrid format, status lifecycle, progress log section, and JSON companion file.

**Implementation steps**:

1. Read current `tasks/README.md`
2. Add new section: "## JSON Companion File" explaining the `.task.json` format
3. Add new section: "## Status Lifecycle" with status transition diagram
4. Add new section: "## Progress Log" explaining the append-only log format
5. Update "## Lifecycle" section to reference status fields instead of directory moves
6. Update example to include progress log section and JSON companion

### Updated Task Templates

**Pattern to follow**: Current `tasks/templates/bug-fix.md`

**Overview**: Add `## Progress Log` section to all four templates. This is the append-only section where each agent records what it did.

```markdown
## Progress Log

<!-- Agents append entries below. Do not edit existing entries. -->
```

**Implementation steps**:

1. Read each template file
2. Append the `## Progress Log` section at the end of each template
3. Verify all four templates have the section

### Updated Marker Scripts

**Pattern to follow**: Current `scripts/mark-tested.sh` and `scripts/mark-manual-tested.sh`

**Overview**: Marker scripts are the **source of truth for evidence**. When a marker script creates evidence (`.case-tested`, `.case-manual-tested`), it also updates the corresponding boolean in `.task.json` as a side effect. Agents should NOT call `task-status.sh` to set `tested` or `manualTested` directly — those flags are only written by marker scripts. This eliminates drift between evidence files and task JSON.

**Key decisions**:

- Marker scripts read `.case-active` to get the task ID, then find `tasks/active/{task-id}.task.json`
- If `.case-active` has no task ID (old-format bare touch) or no `.task.json` exists, skip the JSON update silently (backward compat — the marker file itself is still created)
- `task-status.sh` rejects direct writes to `tested` and `manualTested` from any caller except marker scripts (enforce via a `--from-marker` flag that only the marker scripts pass)

**Implementation steps — mark-tested.sh**:

1. Read current `scripts/mark-tested.sh`
2. After creating the `.case-tested` file (existing behavior), add:
   - Read `.case-active` for task ID
   - If task ID found and `.task.json` exists: `bash ${CASE_REPO}/scripts/task-status.sh <file> tested true --from-marker`
3. Test: pipe test output through script, verify both `.case-tested` file and `.task.json` `tested` field are updated

**Implementation steps — mark-manual-tested.sh**:

1. Read current `scripts/mark-manual-tested.sh`
2. After creating the `.case-manual-tested` file (existing behavior), add:
   - Read `.case-active` for task ID
   - If task ID found and `.task.json` exists: `bash ${CASE_REPO}/scripts/task-status.sh <file> manualTested true --from-marker`
3. Test: run after playwright screenshots exist, verify both `.case-manual-tested` file and `.task.json` `manualTested` field are updated

### Updated Post-PR Cleanup Hook

**Pattern to follow**: Current `hooks/post-pr-cleanup.sh`

**Overview**: Instead of moving task files from `active/` to `done/`, update the status field in the JSON companion to `pr-opened`. Still clean up marker files.

**Key decisions**:

- Use `task-status.sh` to update the JSON rather than inline Python. Keeps hooks thin.
- Fall back to old behavior (move files) if no `.task.json` companion exists. This preserves backward compatibility with old-format task files.
- Extract PR URL from the `gh pr create` output (PostToolUse hook has access to tool output).

**Implementation steps**:

1. Read current `hooks/post-pr-cleanup.sh`
2. **Deterministic task targeting**: instead of iterating all files in `tasks/active/`, identify the active task by:
   - Read `.case-active` marker file — update it to contain the task ID (e.g., `authkit-nextjs-1-issue-53`). The orchestrator writes the task ID into `.case-active` instead of bare `touch`.
   - Use the task ID to find the specific `.task.json`: `${CASE_REPO}/tasks/active/{task-id}.task.json`
   - If `.case-active` has no content (old-format bare touch), fall back to iterating all files in `${CASE_REPO}/tasks/active/` (backward compat)
3. Update the targeted task JSON:
   - Run `bash ${CASE_REPO}/scripts/task-status.sh <file> status pr-opened`
   - If a PR URL is available from the tool output, run `bash ${CASE_REPO}/scripts/task-status.sh <file> prUrl <url>`
4. Keep marker file cleanup (`rm -f .case-active .case-tested .case-manual-tested`)
5. Add fallback: if no `.task.json` found, move `.md` files as before (backward compat)

**Feedback loop**:

- **Playground**: Create test task files (both old format and new hybrid), simulate `gh pr create` by running the hook with mock JSON input
- **Experiment**: Test new format (JSON gets updated), test old format (files get moved), test no task files (clean exit)
- **Check command**: `cat tasks/active/test-task.task.json | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])"`

## Testing Requirements

### Manual Testing

- [ ] Create a test `.task.json` file manually, verify `task-status.sh` can read/write all fields
- [ ] Run `task-status.sh` with invalid inputs (missing file, bad field), verify clear error messages
- [ ] Simulate post-PR hook with mock input, verify JSON status updates
- [ ] Verify backward compatibility: old-format task files still move to `done/`

## Validation Commands

```bash
# Validate JSON schema is valid JSON
python3 -c "import json; json.load(open('tasks/task.schema.json'))"

# Validate task-status.sh is executable and runs
bash scripts/task-status.sh --help 2>&1 || true

# Validate hook scripts have no syntax errors
bash -n hooks/post-pr-cleanup.sh
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
