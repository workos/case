# Pi Consolidation Contract

**Created**: 2026-03-28
**Confidence Score**: 96/100
**Status**: Approved
**Supersedes**: None

## Problem Statement

Case has two execution paths for the same pipeline: a set of Claude Code skills (`/case`, `/case:from-ideation`) that reimplement pipeline orchestration as ~1000 lines of LLM-interpreted prose, and a Pi-based CLI (`ca`) backed by a TypeScript programmatic orchestrator (`src/pipeline.ts`).

The Pi path is the canonical one — it handles revision loops, rubric-based gating, pipeline profiles, metrics collection, tracing, crash-resilient resume, and deterministic phase transitions. The skills know about none of these features. They were the original implementation before the programmatic orchestrator existed, and the `/case` skill was partially migrated (Step 3b shells out to `bun src/index.ts`), but ~300 lines of stale fallback steps remain. The `/case:from-ideation` skill was never migrated at all.

Maintaining two paths means every pipeline change requires updating both TypeScript and prose — and in practice, only the TypeScript gets updated. The skills will only drift further. Meanwhile, the README references `/case` as a primary entry point, creating confusion about which path to use.

## Goals

1. **Single execution path** — All pipeline behavior flows through `ca` CLI → `src/pipeline.ts`. No prose-based pipeline reimplementations exist.
2. **Clean entry point documentation** — README and all docs reference `ca` as the only way to run Case. No `/case` skill references in user-facing docs.
3. **No orphaned code** — Delete the skill directories and any code that only existed to support them. No dead references in other files.

## Success Criteria

- [ ] `skills/case/` directory is deleted
- [ ] `skills/from-ideation/` directory is deleted
- [ ] `skills/security-auditor/` is retained (standalone prompt, not a pipeline reimplementation)
- [ ] README Quick Start, Usage, and "What's in the Harness" sections reference only `ca` CLI
- [ ] No remaining references to `/case` as a skill invocation in docs (README, AGENTS.md, CLAUDE.md, tasks/README.md)
- [ ] No remaining references to `/case:from-ideation` in docs
- [ ] The `security-auditor` skill's invocation path is updated if it was triggered via `/case` skill prose
- [ ] All existing tests pass (`bun test`)
- [ ] TypeScript type-checks (`bun run typecheck`)

## Scope Boundaries

### In Scope

- Delete `skills/case/SKILL.md` and containing directory
- Delete `skills/from-ideation/SKILL.md` and containing directory
- Update README.md: remove `/case` references, make `ca` the documented entry point
- Update AGENTS.md if it references `/case` skill
- Update CLAUDE.md if it references `/case` skill
- Update any task templates or docs that reference `/case` or `/case:from-ideation`
- Verify `security-auditor` skill doesn't depend on deleted skills

### Out of Scope

- Changing the Pi CLI (`ca`) or `src/pipeline.ts` — these are the stable path, not being modified
- Adding new features to `ca` to replace skill-only functionality — `ca` already has feature parity
- Modifying the security auditor skill — it's a standalone prompt, not a pipeline
- Changing agent prompt files (`agents/*.md`) — they're consumed by both paths identically
- Migrating any Claude Code plugin infrastructure (hooks, MCP, etc.) — only skills are affected

### Future Considerations

- If a Claude Code entry point is wanted later, it could be a ~10-line skill that runs `! ca $ARGUMENTS`
- The `security-auditor` could be wired into the Pi pipeline as a phase rather than a skill invocation
- `ca serve` (HTTP mode) could become the primary entry point for webhook-driven work

## Execution Plan

### Dependency Graph

```
Phase 1: Delete skills + update docs
  (single phase — all changes are tightly coupled)
```

### Execution Steps

**Strategy**: Sequential (single phase)

This is small enough for a single spec — deleting two directories and updating references across docs.

1. **Phase 1** — Delete skills and update all references
   ```bash
   /execute-spec docs/ideation/pi-consolidation/spec.md
   ```

---

_This contract was generated from analysis of the Case harness's dual execution paths (Claude Code skills vs Pi CLI) and the decision to consolidate on Pi._
