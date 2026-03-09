# Implementation Spec: Harness Improvements - Phase 5

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Comprehensively review and update all documentation to reflect the changes from Phases 1-4 and any pre-existing undocumented state. This includes AGENTS.md (the primary entry point), task lifecycle docs, golden principles, and any stale references.

This phase runs last because it must reflect all changes from the other phases. The approach is: read every doc, check if it accurately reflects the current state of the harness, and update what's wrong or missing.

## Feedback Strategy

**Inner-loop command**: `grep -r "session-start\|reviewer\|entropy-scan\|parse-test-output" docs/ agents/ AGENTS.md`

**Playground**: The documentation files themselves — read and verify accuracy.

**Why this approach**: Documentation is validated by reading it and cross-referencing against the actual scripts and agent files. The grep confirms new concepts are referenced where expected.

## File Changes

### Modified Files

| File Path | Changes |
| --- | --- |
| `AGENTS.md` | Add reviewer to pipeline, reference session-start, reference entropy scanning, update navigation table, update task lifecycle |
| `docs/golden-principles.md` | Review for completeness — any new invariants from Phases 1-4 |
| `docs/playbooks/README.md` | Update if any playbook references need revision |
| `docs/playbooks/fix-bug.md` | Update pipeline steps to include reviewer |
| `docs/playbooks/add-feature.md` | Update pipeline steps to include reviewer |
| `docs/conventions/README.md` | Verify all convention docs are listed (entropy-management added in Phase 4) |
| `tasks/README.md` | Update task lifecycle to include reviewer step and structured test output |

## Implementation Details

### AGENTS.md update

**Pattern to follow**: Current AGENTS.md (concise routing map, ~50 lines, table format)

**Overview**: The primary entry point for agents needs to reflect:
1. The reviewer agent in the pipeline (implementer → verifier → reviewer → closer)
2. The session-start script as the first thing every agent runs
3. Entropy scanning as a maintenance tool
4. Structured test output in the evidence model

**Key changes**:

1. Add to the Navigation table:

```markdown
| Agent roles | `agents/` |
| Entropy management | `docs/conventions/entropy-management.md` |
```

2. Update Task Lifecycle section to include reviewer:

```markdown
Lifecycle: `tasks/active/` → `tasks/done/` (moved after PR merge)

Pipeline: implementer → verifier → reviewer → closer → (retrospective)
```

3. Add session-start reference in "Working in a Target Repo":

```markdown
0. Run `scripts/session-start.sh {repo-path}` to gather context
1. Read the repo's `CLAUDE.md` ...
```

**Implementation steps**:
1. Read current AGENTS.md
2. Add reviewer to pipeline description
3. Add session-start to working steps
4. Add navigation entries for new docs
5. Keep it under ~60 lines (concise routing map, not a manual)

**Feedback loop**:
- **Playground**: Read AGENTS.md and verify it accurately routes to all new artifacts
- **Experiment**: For each new artifact (session-start, reviewer, entropy-scan, parse-test-output), verify AGENTS.md either mentions it or points to the doc that does
- **Check command**: `wc -l AGENTS.md` (should stay under 70 lines)

### Task lifecycle documentation

**Pattern to follow**: `tasks/README.md` current format

**Overview**: Update the task file format spec and lifecycle to reflect:
1. Reviewer as a pipeline step (status: `reviewing` between `verifying` and `closing`)
2. `.case-reviewed` as an evidence marker
3. Structured test output fields in `.case-tested`

**Key changes**:

1. Add `reviewing` to the status lifecycle:
```
active → implementing → verifying → reviewing → closing → pr-opened → merged
```

2. Add `.case-reviewed` to evidence markers section

3. Document the richer `.case-tested` format (from Phase 1):
```
timestamp: ...
output_hash: ...
passed: N
failed: N
total: N
duration_ms: N
suites: N
files: [...]
```

**Implementation steps**:
1. Read `tasks/README.md`
2. Update status lifecycle
3. Add reviewing step description
4. Add `.case-reviewed` marker documentation
5. Update `.case-tested` format documentation

### Playbook updates

**Overview**: Both `fix-bug.md` and `add-feature.md` describe the pipeline steps. Update them to include the reviewer step.

**Implementation steps**:
1. Read each playbook
2. Insert reviewer step between verify and PR creation
3. Keep changes minimal — just add the step, don't restructure

### Golden principles review

**Overview**: Check if Phases 1-4 introduced any new invariants that should be documented. Candidates:
- "Every PR must pass code review" (enforced via `.case-reviewed` gate)
- "Test output should use JSON reporter when available" (advisory)

**Implementation steps**:
1. Read `docs/golden-principles.md`
2. Assess whether the new artifacts warrant new principles
3. Add only if they represent true cross-repo invariants (not case-internal rules)

### Comprehensive doc audit

**Overview**: Beyond the specific files above, scan all docs for stale references, broken links, or outdated information. This catches pre-existing documentation debt that predates this project.

**Implementation steps**:
1. List all files in `docs/`, `agents/`, `tasks/`, `scripts/`
2. For each doc file, verify:
   - Internal cross-references point to files that exist
   - Script paths in instructions match actual script locations
   - Pipeline descriptions match the current agent set
   - Command examples use current syntax
3. Fix any stale references found

## Testing Requirements

### Manual Testing

- [ ] AGENTS.md mentions reviewer in pipeline
- [ ] AGENTS.md references session-start script
- [ ] AGENTS.md stays under 70 lines
- [ ] tasks/README.md includes `reviewing` status
- [ ] tasks/README.md documents `.case-reviewed` marker
- [ ] Playbooks include reviewer step
- [ ] No broken internal cross-references in docs/
- [ ] All script paths in agent files point to existing scripts

## Validation Commands

```bash
# Verify AGENTS.md references key new artifacts
grep -q "reviewer" AGENTS.md && echo "PASS: reviewer" || echo "FAIL"
grep -q "session-start" AGENTS.md && echo "PASS: session-start" || echo "FAIL"
echo "AGENTS.md lines: $(wc -l < AGENTS.md)"

# Verify task lifecycle
grep -q "reviewing" tasks/README.md && echo "PASS: reviewing status" || echo "FAIL"
grep -q "case-reviewed" tasks/README.md && echo "PASS: review marker" || echo "FAIL"

# Verify playbooks updated
grep -q "review" docs/playbooks/fix-bug.md && echo "PASS: fix-bug" || echo "FAIL"

# Check for broken script references in agent files
for script in session-start.sh mark-tested.sh mark-reviewed.sh mark-manual-tested.sh entropy-scan.sh parse-test-output.sh; do
  if grep -rl "$script" agents/ docs/ > /dev/null 2>&1; then
    test -f "scripts/$script" && echo "PASS: $script exists" || echo "FAIL: $script referenced but missing"
  fi
done

# Comprehensive cross-reference check
grep -rhoE 'scripts/[a-z-]+\.sh' agents/ docs/ | sort -u | while read -r ref; do
  test -f "$ref" && echo "PASS: $ref" || echo "FAIL: $ref not found"
done
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
