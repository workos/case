# Agent Orchestrator Flows Contract

**Created**: 2026-03-18
**Confidence Score**: 96/100
**Status**: Approved

## Problem Statement

The `--agent` interactive orchestrator session has the infrastructure (Pi TUI, custom tools, repo detection) but no smooth path from conversation to execution. Users can discuss a problem and then... manually create task files and invoke tools. There's no "go" button.

Two workflows are needed and neither exists:

1. **Quick flow**: User discusses a focused fix, says "go," and the agent should synthesize the conversation into artifacts and run the pipeline. Currently the agent has `create_task` and `run_pipeline` as separate tools but no guidance or tooling to bridge conversation context → formal artifacts → pipeline execution in one motion.

2. **Ideation flow**: User wants to brainstorm a larger change, produce formal specs, review them, and then execute phases. The ideation skill exists for Claude Code but can't be invoked from a Pi session. The from-ideation execution logic exists in SKILL.md but isn't available as a Pi tool.

## Goals

1. **Seamless quick handoff**: User discusses, says "go," agent writes lightweight ideation artifacts (spec or contract+spec, agent decides based on scope), then executes through the pipeline — all within one session.
2. **Native ideation in Pi**: The orchestrator agent can run the ideation flow natively — brainstorm, ask questions, write contract and specs — without invoking external Claude Code skills.
3. **From-ideation execution tool**: A `run_from_ideation` Pi tool that executes ideation contracts through the pipeline (all phases on one branch, one PR), handling both agent-produced and pre-existing artifacts.
4. **Consistent artifact path**: Both quick and ideation flows produce artifacts in `docs/ideation/`, so there's always a reviewable record of what was planned and why.

## Success Criteria

- [ ] `xcase --agent` → discuss a fix → say "go" → agent writes spec to `docs/ideation/{slug}/` → pipeline runs → PR opened
- [ ] `xcase --agent` → brainstorm larger work → agent writes contract + multi-phase specs → user reviews → "execute phase 1" → pipeline runs
- [ ] `xcase --agent` → "execute docs/ideation/existing-project/" → `run_from_ideation` tool picks up pre-existing artifacts and runs them
- [ ] Quick flow: agent decides whether to write spec-only or contract+spec based on scope
- [ ] Ideation flow: agent asks clarifying questions, iterates on artifacts, presents for approval before execution
- [ ] From-ideation tool: handles multi-phase sequential execution on one branch, re-entry on interruption
- [ ] All existing tests pass, typecheck clean, lint clean
- [ ] System prompt clearly guides the agent on when to use which flow

## Scope Boundaries

### In Scope

- New `run_from_ideation` Pi tool (ToolDefinition) that ports the from-ideation SKILL.md execution logic
- Enriched orchestrator system prompt describing both flows and decision heuristics
- System prompt guidance for native ideation (brainstorming, artifact writing, approval flow)
- System prompt guidance for quick handoff (conversation synthesis → artifacts → pipeline)
- Tests for the new tool

### Out of Scope

- Porting the full ideation skill's confidence scoring/rubric into the Pi agent — the agent uses its judgment, guided by system prompt
- Porting Claude Code hooks/plugins to Pi extensions — separate project
- Changes to the pipeline itself (runPipeline, phases, evidence markers) — all existing infra
- Changes to the from-ideation SKILL.md — it continues working for Claude Code users
- Ideation template/reference files — the agent can reference existing ones via Pi's read tool

### Future Considerations

- Pi extensions for structured ideation workflows (confidence scoring as a tool, template rendering)
- Shared session history across `--agent` invocations for continuity
- Integration with ideation skill's confidence rubric as a formal Pi tool
- Steer/followUp integration for interjecting during pipeline execution

## Execution Plan

### Dependency Graph

```
Phase 1: run_from_ideation tool + system prompt enrichment + tests
```

Single phase — no dependencies.

### Execution Steps

**Strategy**: Sequential (single phase)

1. **Phase 1** — from-ideation module, tool, system prompt, tests

   ```bash
   /ideation:execute-spec docs/ideation/agent-orchestrator-flows/spec.md
   ```

---

_This contract was approved on 2026-03-18._
