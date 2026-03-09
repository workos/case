# Harness Improvements Contract

**Created**: 2026-03-08
**Confidence Score**: 95/100
**Status**: Approved

## Problem Statement

The case harness was evaluated against two reference articles — Anthropic's "Effective Harnesses for Long-Running Agents" and OpenAI's "Harness Engineering: Leveraging Codex in an Agent-First World." While case independently arrived at many best practices (progressive disclosure, mechanical enforcement, multi-agent pipeline, retrospective feedback loops), four gaps were identified:

1. **No session initialization routine.** Each agent role has setup steps, but there's no shared script that bootstraps context at the start of every context window — reading git log, task status, running smoke tests. The Anthropic article found this was the single highest-leverage intervention for token savings.

2. **No automated entropy management.** `check.sh` exists but runs manually. Convention drift accumulates between manual sweeps. The Codex article describes continuous "garbage collection" that catches drift early.

3. **No code review agent.** The pipeline has implementer → verifier → closer, but no agent that reviews the diff for golden-principle violations, architectural coherence, or code quality before PR creation.

4. **No structured observability.** Agents can run tests and capture screenshots, but test results are opaque text blobs. Structured test output (pass/fail counts, coverage deltas, timing) would give agents — and the review agent — concrete signals to reason about.

## Goals

1. **Reduce per-session bootstrap cost** by providing a single `scripts/session-start.sh` that every agent runs first, eliminating redundant git/task/env discovery across all roles
2. **Catch convention drift continuously** via `/loop`-compatible entropy scans during active sessions, rather than relying solely on manual `check.sh` invocations
3. **Add a code review gate** by evolving the `ideation:reviewer` subagent into a pipeline-aware reviewer that blocks PR creation on critical findings and posts advisory comments on the PR
4. **Make test results machine-readable** by producing structured JSON output from test runs, giving agents concrete pass/fail/coverage/timing signals instead of parsing raw console output

## Success Criteria

- [ ] `scripts/session-start.sh` exists and outputs structured JSON context (branch, task status, last commit, test baseline)
- [ ] All 4 agent roles (implementer, verifier, closer, retrospective) reference session-start in their setup steps
- [ ] `scripts/entropy-scan.sh` exists, wraps `check.sh` with structured JSON output, and is `/loop`-compatible (exit 0 with status, not interactive)
- [ ] Documentation describes how to use `/loop` with entropy scanning during active sessions
- [ ] `agents/reviewer.md` exists following the same pattern as other agent roles (YAML frontmatter, structured workflow, AGENT_RESULT output)
- [ ] Reviewer agent reads golden principles and produces structured findings (critical/warning/info)
- [ ] `pre-pr-check.sh` gains a review-evidence gate (`.case-reviewed` marker)
- [ ] Reviewer can post findings as PR comments via `gh api`
- [ ] `scripts/parse-test-output.sh` exists and converts vitest output to structured JSON (pass count, fail count, coverage %, duration, file-level breakdown)
- [ ] `mark-tested.sh` is updated to use structured output (richer than current hash-only evidence)
- [ ] Reviewer agent consumes structured test output to flag regressions or coverage drops

## Scope Boundaries

### In Scope

- New `scripts/session-start.sh` with structured JSON output
- Updates to all 4 agent role files to reference session-start
- New `scripts/entropy-scan.sh` wrapping `check.sh` for `/loop` use
- Documentation for `/loop` + entropy scanning workflow
- New `agents/reviewer.md` role definition
- Evolution of `ideation:reviewer` subagent with golden-principles awareness
- New `.case-reviewed` evidence marker and corresponding `mark-reviewed.sh` script
- Update `pre-pr-check.sh` to gate on `.case-reviewed`
- Update `hooks/hooks.json` if needed for new hook points
- New `scripts/parse-test-output.sh` for vitest JSON parsing
- Update `mark-tested.sh` to capture richer structured data
- Update pipeline docs (AGENTS.md, task lifecycle) to include reviewer step

### Out of Scope

- Full observability stack (LogQL, PromQL, TraceQL) — overkill for SDK repos
- GitHub Actions CI integration — case is ad-hoc, not CI-driven
- Persistent scheduled tasks — `/loop` is session-scoped by design
- Changes to target repo source code — case only modifies case/ artifacts
- New hook types beyond PreToolUse/PostToolUse — work within existing hook model

### Future Considerations

- GitHub Actions for persistent entropy scanning (if ad-hoc proves insufficient)
- Coverage threshold enforcement per repo (once structured test output is stable)
- Reviewer auto-fix mode (apply golden-principle fixes, not just flag them)
- Cross-repo review (reviewer checks consistency across repos for cross-repo tasks)

## Execution Plan

### Dependency Graph

```
Phase 1 (Structured Test Output) ──┬──────────────────── Phase 3 (Reviewer Agent) ──┐
Phase 2 (Session-Start Script) ────┤                                                 ├── Phase 5 (Docs)
Phase 4 (Entropy Management) ──────┘─────────────────────────────────────────────────┘
```

Phases 1, 2, and 4 are independent. Phase 3 is blocked by Phase 1 (needs structured test output). Phase 5 is blocked by all others (documents final state).

### Execution Steps

**Strategy**: Hybrid (parallel first wave, then sequential)

1. **Phases 1, 2 & 4** — parallel first wave _(independent)_

   Start one Claude Code session, enter delegate mode (Shift+Tab), paste the agent team prompt below.

2. **Phase 3** — Reviewer Agent _(blocked by Phase 1)_
   ```
   /execute-spec docs/ideation/harness-improvements/spec-phase-3.md
   ```

3. **Phase 5** — Documentation Update _(blocked by all)_
   ```
   /execute-spec docs/ideation/harness-improvements/spec-phase-5.md
   ```

### Agent Team Prompt

```
Implement 3 independent phases of the harness-improvements project in parallel.
Each phase modifies different files with no overlap. Create an agent team with
3 teammates, each assigned one phase.

Spawn 3 teammates with plan approval required. Each teammate should:
1. Read their assigned spec file
2. Explore the codebase for relevant patterns (especially scripts/ and agents/)
3. Plan their implementation approach and wait for approval
4. Implement following spec and codebase patterns
5. Run validation commands from their spec after implementation

Teammates:

1. "Structured Test Output" — docs/ideation/harness-improvements/spec-phase-1.md
   New scripts/parse-test-output.sh and update to scripts/mark-tested.sh.
   Also updates agents/implementer.md test command guidance.

2. "Session-Start Script" — docs/ideation/harness-improvements/spec-phase-2.md
   New scripts/session-start.sh and updates to all 4 agent role files
   (agents/implementer.md, agents/verifier.md, agents/closer.md, agents/retrospective.md).

3. "Entropy Management" — docs/ideation/harness-improvements/spec-phase-4.md
   New scripts/entropy-scan.sh and docs/conventions/entropy-management.md.
   Also updates docs/conventions/README.md.

Coordinate on agents/implementer.md — both teammates 1 and 2 modify it.
Teammate 1 updates the test command, teammate 2 adds session-start step.
Only one teammate should modify it at a time.
```

---

_This contract was generated from a gap analysis of the case harness against Anthropic and OpenAI reference articles on agent harness engineering._
