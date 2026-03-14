> **Mission**: {one-line what + why}
> **Repo**: {target repo path}
> **Done when**: {single most important acceptance criterion}

# Fix: {brief description}

## Objective

{What's broken and what the fix should achieve. Be specific about expected vs actual behavior.}

## Target Repos

- {../repo-path}

## Playbook

docs/playbooks/fix-bug.md

## Issue Reference

{GitHub issue URL, error message, or detailed reproduction steps}

## Context

{Any additional context: when it started, affected versions, related code paths, user reports.}

## Success Condition

<!-- Machine-checkable command that measures progress. Implementer runs this after each attempt. -->
<!-- Example: pnpm test --reporter=json 2>&1 | jq '.numPassedTests' -->
<!-- Set checkCommand, checkBaseline, checkTarget in the companion .task.json -->

## Acceptance Criteria

- [ ] Bug is reproducible with a failing test
- [ ] Fix addresses root cause (not just the symptom)
- [ ] No regressions (all existing tests pass)
- [ ] New test prevents recurrence
- [ ] TypeScript strict mode, no errors
- [ ] All repo checks pass (test, typecheck, lint, format, build)

## Checklist

- [ ] Read playbook (`docs/playbooks/fix-bug.md`)
- [ ] Read target repo's AGENTS.md for setup and architecture
- [ ] Reproduce bug (write failing test or document steps)
- [ ] Identify root cause
- [ ] Implement fix
- [ ] Verify fix (failing test now passes)
- [ ] Run full check suite: {pnpm test && pnpm typecheck && ...}
- [ ] Open PR with conventional commit: `fix: {description}`

## Progress Log

<!-- Agents append entries below. Do not edit existing entries. -->
