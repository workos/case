# Orchestrator Refinement Contract

**Created**: 2026-03-14
**Confidence Score**: 95/100
**Status**: Draft

## Problem Statement

The Case orchestrator (waves 4-5 from improvements.md) has two problems:

1. **Agent spawning bypasses the harness.** `agent-runner.ts` tries the Claude Agent SDK first, which skips hooks, plugins, and CLAUDE.md — the entire enforcement layer that makes Case work. The CLI fallback uses `claude --print` but lacks proper flags (`--worktree`, `--allowedTools`, `--output-format`).

2. **Wave 5 was implemented prematurely.** The HTTP server, GitHub webhooks, and background scanners solve problems at Stripe's scale (1000 PRs/week), not Case's (a few tasks across 5 repos). The orchestrator core (pipeline loop, phase modules, metrics, context assembly) is justified by determinism and correctness arguments that apply at any scale. The service layer is not.

These issues mean the orchestrator exists as compiled code but cannot run a real task end-to-end.

## Goals

1. Agent runner spawns agents exclusively via `claude` CLI with `--worktree` isolation, `--allowedTools` from agent frontmatter, and structured output parsing
2. `improvements.md` accurately distinguishes completed infrastructure (Wave 4: pipeline, metrics, context assembly) from premature infrastructure (Wave 5: server, webhooks, scanners)
3. CLI supports `bun src/index.ts create --repo <name> --title <title>` for task creation without a running server
4. `bun src/index.ts --task <path> --dry-run` completes the full pipeline loop without errors
5. SDK dependency removed, signaling CLI-only architecture

## Success Criteria

- [ ] `bun run typecheck` passes with zero errors
- [ ] `bun test` passes — all existing tests still work with updated mocks
- [ ] `bun src/index.ts --task tasks/active/<file>.task.json --dry-run` completes implement → verify → review → close → retrospective → complete
- [ ] `bun src/index.ts create --repo cli --title "test task" --description "test"` creates a `.task.json` + `.md` pair in `tasks/active/`
- [ ] `agent-runner.ts` has zero references to `@anthropic-ai/claude-agent-sdk`
- [ ] Agent frontmatter `tools` field is parsed and passed as `--allowedTools` to CLI
- [ ] `improvements.md` Wave 5 items are in deferred section with rationale
- [ ] `package.json` no longer lists `@anthropic-ai/claude-agent-sdk` as a dependency

## Scope Boundaries

### In Scope

- Rewrite `agent-runner.ts` to CLI-only spawning with proper flags
- Create frontmatter parser utility (`src/util/parse-frontmatter.ts`)
- Add `AgentMetadata` type to `src/types.ts`
- Add `create` subcommand to `src/index.ts`
- Update `improvements.md` with Wave 5 reclassification and rationale
- Remove `@anthropic-ai/claude-agent-sdk` from `package.json`
- Update test mocks if `spawnAgent` signature changes

### Out of Scope

- Deleting Wave 5 code (server.ts, scanners, webhooks) — left in place per decision
- Changing phase module logic — phase modules are clean and don't need changes
- Changing the pipeline loop, metrics, or context assembly
- Adding new agent phases or modifying agent prompts
- Running a real (non-dry-run) task through the pipeline

### Future Considerations

- Transcript capture (`--output-format stream-json` saved to file) for retrospective analysis
- Wave 5 activation when scale justifies a running service
- Linear webhook handler (schema supports it, no handler exists)

## Execution Plan

### Dependency Graph

```
Phase 1: improvements.md update (docs only)
Phase 2: Agent runner + CLI create (code)
  └── depends on nothing — independent of Phase 1
```

### Execution Steps

**Strategy**: Sequential (2 small phases, no parallelism needed)

1. **Phase 1** — Update improvements.md _(independent, docs only)_

   ```bash
   /execute-spec docs/ideation/orchestrator-refinement/spec-phase-1.md
   ```

2. **Phase 2** — Agent runner rewrite + CLI create command _(code changes)_
   ```bash
   /execute-spec docs/ideation/orchestrator-refinement/spec-phase-2.md
   ```
