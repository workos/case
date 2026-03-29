# Implementation Spec: Pi Consolidation

**Contract**: ./contract.md
**Estimated Effort**: S

## Technical Approach

Delete the two Claude Code skill directories (`skills/case/`, `skills/from-ideation/`) that reimplement pipeline orchestration as LLM-interpreted prose. The Pi-based `ca` CLI already provides full feature parity via the TypeScript programmatic orchestrator.

Then sweep all documentation files for references to `/case` (as a skill invocation), `/case:from-ideation`, and `skills/case/` or `skills/from-ideation/` paths. Replace with `ca` CLI equivalents. The `security-auditor` skill is retained — it's a standalone security prompt, not a pipeline reimplementation.

## Feedback Strategy

**Inner-loop command**: `bun test`
**Playground**: Test suite + `grep -r "/case" docs/ README.md AGENTS.md` to verify no stale references.
**Why this approach**: Changes are deletions and doc edits — no new logic to test.

## File Changes

### New Files

_None_

### Modified Files

| File Path | Changes |
|---|---|
| `README.md` | Remove `/case` skill references from Quick Start, Usage, mermaid diagram, and "What's in the Harness". Make `ca` the sole documented entry point. |
| `AGENTS.md` | Remove `/case:from-ideation` reference (line 52), replace with `ca --from-ideation <folder>` equivalent |

### Deleted Files

| File Path | Reason |
|---|---|
| `skills/case/SKILL.md` | Stale prose-based pipeline reimplementation. Pi path (`ca` CLI) supersedes. |
| `skills/from-ideation/SKILL.md` | Stale prose-based ideation pipeline. Pi path (`src/agent/from-ideation.ts`) supersedes. |
| `skills/case/` (directory) | Contains only SKILL.md |
| `skills/from-ideation/` (directory) | Contains only SKILL.md |

## Implementation Details

### 1. Delete skill directories

**Overview**: Remove the two skill directories entirely. The `skills/` directory itself may be kept if `security-auditor/` remains.

**Implementation steps**:

1. Delete `skills/case/` directory
2. Delete `skills/from-ideation/` directory
3. Verify `skills/security-auditor/SKILL.md` still exists and is unmodified

### 2. Update README.md

**Pattern to follow**: The README was recently updated (commit `5bf1f5e`) to clarify `ca` vs `/case`. This change completes that migration.

**Overview**: Remove all remaining `/case` skill references. The Quick Start already uses `ca` as primary, but several sections still mention `/case`.

**Key changes**:

1. **Quick Start** (lines ~16-17): Remove `/case 34` and `/case DX-1234` — these are skill invocations. Keep only `ca` CLI examples.
2. **Resume section** (line ~34): Remove `/case 34` reference, use `ca 34` instead
3. **Mermaid diagram** (line ~65): Change `"Engineer: /case 34"` to `"Engineer: ca 34"`
4. **Usage section** (line ~166): Remove "The `/case` skill dispatches to the orchestrator automatically. You can also invoke `ca` directly." — replace with a note that `ca` is the CLI entry point.
5. **"What's in the Harness"** (lines ~360-362): Remove the three skill entries:
   - `case/                               /case skill (orchestrator + pipeline)`
   - `from-ideation/                      /execute-spec skill (ideation → pipeline)`
   - `security-auditor/                   Security audit (auto-invoked, not user-facing)`

   Replace with just:
   - `skills/security-auditor/            Security audit (auto-invoked by closer pre-flight)`

### 3. Update AGENTS.md

**Overview**: Line 52 references `/case:from-ideation`. Replace with `ca` equivalent.

**Implementation steps**:

1. Read AGENTS.md
2. Replace `/case:from-ideation <folder>` with `ca --from-ideation <folder>` (or equivalent `ca` invocation)
3. Remove reference to `skills/from-ideation/SKILL.md` — point to `src/agent/from-ideation.ts` instead
4. Scan for any other `/case` references and update

### 4. Verify no orphaned references

**Overview**: Grep across the entire repo for stale references.

**Implementation steps**:

1. `grep -r "skills/case/" .` — should return nothing (except git history)
2. `grep -r "skills/from-ideation/" .` — should return nothing
3. `grep -r "/case:from-ideation" . --include="*.md"` — should return nothing outside `docs/ideation/`
4. `grep -r '"/case ' . --include="*.md"` — should return nothing (the skill invocation pattern)
5. Verify `security-auditor` skill doesn't reference the deleted skills

## Testing Requirements

### Validation

- All existing tests pass: `bun test`
- TypeScript type-checks: `bun run typecheck`
- No stale references: `grep -rn "skills/case\b" . --include="*.md" | grep -v ideation` returns empty
- No stale references: `grep -rn "/case:from-ideation" . --include="*.md" | grep -v ideation` returns empty
- `skills/security-auditor/SKILL.md` still exists

## Validation Commands

```bash
# Type checking
bun run typecheck

# Unit tests
bun test

# Stale reference check
grep -rn "skills/case/" . --include="*.md" | grep -v ideation | grep -v pi-consolidation
grep -rn "/case:from-ideation" . --include="*.md" | grep -v ideation | grep -v pi-consolidation

# Verify security-auditor retained
test -f skills/security-auditor/SKILL.md && echo "OK" || echo "MISSING"
```
