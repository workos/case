# Case Multi-Agent Contract

**Created**: 2026-03-08
**Confidence Score**: 95/100
**Status**: Approved

## Problem Statement

The `/case` skill runs as a single agent that handles issue parsing, implementation, testing, manual verification, evidence collection, PR creation, and task lifecycle management — all in one context window. By the time the agent finishes implementing a fix, the pre-PR checklist instructions have decayed or been compacted. This leads to two recurring failures:

1. **Verification skipping**: The agent skips manual testing or games evidence markers (e.g., running `touch .case-tested` instead of piping test output). Hooks catch this at the gate, but the agent has already lost the context to recover gracefully. Root cause: the agent that *wrote* the code is asked to *objectively test* it — context pollution makes this unreliable.

2. **Task lifecycle failure**: Task files are created in `tasks/active/` but rarely updated during work and inconsistently moved to `tasks/done/`. The post-PR cleanup hook handles the move, but if it fails silently or the PR is never created, task files become orphaned. The Markdown checkbox format is write-once in practice — agents create the file and never update it.

These are not capability problems — they're context management problems. A fresh agent with a focused prompt can verify work more reliably than the same agent that's been implementing for thousands of tokens.

## Goals

1. **Split `/case` into four phase-separated subagents** (orchestrator, implementer, verifier, closer) so each agent operates with a clean, focused context window
2. **Add baseline smoke testing** before implementation begins, so agents don't build on broken foundations (inspired by Anthropic's "get up to speed" pattern)
3. **Make task files living scratchpads** that agents update throughout work, not static planning documents
4. **Add JSON companion files for machine-touched fields** (status, tested, evidence) so agents flip structured fields instead of editing Markdown checkboxes
5. **Replace directory-move lifecycle with status fields** so task tracking doesn't depend on fragile file moves between `active/` and `done/`

## Success Criteria

- [ ] Orchestrator creates task file + JSON companion, runs bootstrap smoke test, spawns implementer
- [ ] Implementer writes fix + unit tests in a focused context, updates task progress log
- [ ] Verifier starts with fresh context, reads diff, runs Playwright testing, captures screenshots, creates evidence markers — catches issues the implementer missed
- [ ] Closer creates PR with proper description, satisfies all hook gates, updates task status to `pr-opened`
- [ ] Pre-PR hooks pass without human intervention on a real issue that previously failed (e.g., issue 53)
- [ ] Task JSON status field transitions correctly: `active` → `implementing` → `verifying` → `pr-opened` → `merged`
- [ ] Task file contains running progress log showing what each agent did
- [ ] Agent prompt files exist for implementer, verifier, and closer (following ideation's `reviewer.md`/`scout.md` pattern)
- [ ] Existing hooks work unchanged — closer must satisfy them like any agent
- [ ] `/case 53` re-run produces a PR with actual manual testing evidence and specific-fix verification

## Scope Boundaries

### In Scope

- Rewrite SKILL.md to orchestrate four subagent phases
- Create agent prompt files: `agents/implementer.md`, `agents/verifier.md`, `agents/closer.md`
- New task file format: Markdown body + `.task.json` companion for machine fields
- Status-based task lifecycle (JSON fields, no directory moves)
- Baseline smoke test via bootstrap.sh before implementation
- Progress log section in task files (append-only, per-agent entries)
- Update task templates to new hybrid format
- Update `tasks/README.md` with new format spec
- Update post-PR cleanup hook to set status field instead of moving files
- Bump plugin version

### Out of Scope

- Changing hook enforcement logic — hooks stay as-is, closer must satisfy them
- Migrating existing `tasks/done/` files to new format — only new tasks use new format
- Claude Agent SDK integration — staying within Claude Code plugin/skill architecture
- Parallel implementer agents (e.g., splitting a fix across multiple subagents) — single implementer per issue
- Changes to playbooks, architecture docs, or golden principles — those are fine as-is
- Changes to `projects.json` manifest or target repo CLAUDE.md files

### Future Considerations

- Multi-implementer parallelism for large cross-repo changes
- Session bridging artifact (like Anthropic's `claude-progress.txt`) for issues spanning multiple `/case` invocations
- Audit/compliance agent that reviews completed PRs against golden principles
- Automated `/case` dispatch from GitHub webhook (the "automated mode" discussed earlier)
- JSON feature list pattern (Anthropic-style) for large feature work vs. single-issue fixes
- Orchestrator-managed worktrees for isolation between concurrent `/case` runs and cleaner subagent handoffs
- Platform evaluation (Claude Agent SDK, pi.dev) if Claude Code's Agent tool or hooks hit limitations
- Async ingress layer (dispatcher/queue) for event-driven kickoff from GitHub webhooks or Slack — current architecture is sequential inside one invocation

## Execution Plan

### Dependency Graph

```
Phase 1: Task Infrastructure
  └── Phase 2: Agent Prompt Files  (blocked by Phase 1)
        └── Phase 3: Orchestrator SKILL.md Rewrite  (blocked by Phase 2)
              └── Phase 4: Integration & Validation  (blocked by Phase 3)
```

### Execution Steps

**Strategy**: Sequential — all phases form a linear chain.

1. **Phase 1 — Task Infrastructure** _(foundation, blocks all others)_
   ```
   /ideation:execute-spec docs/ideation/case-multi-agent/spec-phase-1.md
   ```

2. **Phase 2 — Agent Prompt Files** _(blocked by Phase 1)_
   ```
   /ideation:execute-spec docs/ideation/case-multi-agent/spec-phase-2.md
   ```

3. **Phase 3 — Orchestrator SKILL.md Rewrite** _(blocked by Phase 2)_
   ```
   /ideation:execute-spec docs/ideation/case-multi-agent/spec-phase-3.md
   ```

4. **Phase 4 — Integration & Validation** _(blocked by Phase 3)_
   ```
   /ideation:execute-spec docs/ideation/case-multi-agent/spec-phase-4.md
   ```
