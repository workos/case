# Implementation Spec: Case Multi-Agent - Phase 4

**Contract**: ./contract.md
**Estimated Effort**: S

## Technical Approach

Phase 4 is integration and validation. Bump the plugin version, reinstall, and test against real issues that previously had problems. This phase produces no new code — it validates that Phases 1-3 work correctly together.

The validation plan tests against known failure cases: issue 53 (authkit-tanstack-start) where the single-agent gamed markers, and optionally a new issue to verify the full lifecycle.

## File Changes

### Modified Files

| File Path | Changes |
|-----------|---------|
| `.claude-plugin/plugin.json` | Bump version from 0.7.0 to 0.8.0 |
| `.claude-plugin/marketplace.json` | Bump version from 0.7.0 to 0.8.0 |

## Implementation Details

### Version Bump

**Overview**: Update both plugin manifests to v0.8.0 to reflect the multi-agent architecture change.

**Implementation steps**:

1. Read `.claude-plugin/plugin.json`, update `"version": "0.7.0"` → `"version": "0.8.0"`
2. Read `.claude-plugin/marketplace.json`, update `"version": "0.7.0"` → `"version": "0.8.0"`
3. Verify JSON is valid: `python3 -c "import json; json.load(open('.claude-plugin/plugin.json'))"`

### Plugin Reinstall

**Overview**: Uninstall and reinstall the case plugin to pick up all changes.

**Implementation steps**:

1. Update marketplace: `claude plugin marketplace update`
2. Uninstall: `claude plugin uninstall case`
3. Reinstall: `claude plugin install case`
4. Verify: the install output should show version 0.8.0

### Validation: Known Failure Case

**Overview**: Test `/case 53` on authkit-tanstack-start (or equivalent issue) to verify the multi-agent pipeline fixes the known failure where the single agent gamed markers.

**Validation checklist**:

- [ ] Orchestrator creates task file (.md + .task.json) in tasks/active/
- [ ] Orchestrator runs baseline smoke test (bootstrap.sh) before spawning implementer
- [ ] Implementer is spawned as a subagent with focused context
- [ ] Implementer writes fix and commits (does NOT create evidence markers via `touch`)
- [ ] Implementer pipes test output through `mark-tested.sh`
- [ ] Verifier is spawned as a fresh subagent
- [ ] Verifier reads the diff (not the implementation context)
- [ ] Verifier starts example app and uses Playwright to test the **specific fix** (not just happy path)
- [ ] Verifier creates `.case-manual-tested` via `mark-manual-tested.sh` (with evidence)
- [ ] Verifier captures and uploads screenshots
- [ ] Closer is spawned as a subagent
- [ ] Closer pre-flight check passes (evidence markers have content, not just `touch`)
- [ ] Closer creates PR with thorough description including verification notes and screenshots
- [ ] Pre-PR hook passes without human intervention
- [ ] Task JSON status is `pr-opened`
- [ ] Task progress log has entries from all four agents

### Validation: New Issue

**Overview**: Optionally test on a fresh GitHub or Linear issue to verify the pipeline works end-to-end for a new case.

**Validation checklist**:

- [ ] Full pipeline completes: orchestrator → implementer → verifier → closer
- [ ] Task lifecycle tracked correctly in JSON
- [ ] Progress log is readable and complete
- [ ] PR is created with proper description

## Testing Requirements

### Manual Testing

- [ ] Run `/case 53` (or equivalent) in a new Claude Code session
- [ ] Observe each subagent spawn (implementer, verifier, closer) in sequence
- [ ] Verify the PR description includes actual verification notes (not boilerplate)
- [ ] Verify screenshots in PR description are real (not placeholder text)
- [ ] Check task JSON file has all fields populated correctly

## Validation Commands

```bash
# Verify plugin version
cat .claude-plugin/plugin.json | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])"

# Verify marketplace version matches
cat .claude-plugin/marketplace.json | python3 -c "import sys,json; print(json.load(sys.stdin)['metadata']['version'])"

# Verify agent files are accessible from plugin root
ls -la agents/implementer.md agents/verifier.md agents/closer.md

# Verify task schema exists
ls -la tasks/task.schema.json

# Verify task-status script is executable
test -x scripts/task-status.sh && echo "OK" || echo "FAIL: not executable"
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
