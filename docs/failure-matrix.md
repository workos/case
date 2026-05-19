# Phase Failure Matrix

This document is the human-readable view of the unified stop-condition matrix.
The authoritative TypeScript implementation lives at
[`src/dag/outcome-table.ts`](../src/dag/outcome-table.ts). The two **must stay
in sync** — exhaustiveness tests in
[`src/__tests__/outcome-table.spec.ts`](../src/__tests__/outcome-table.spec.ts)
assert that every applicable `(phase, outcome)` pair maps to a defined
action, with no `default` fallthrough.

When a phase surfaces an outcome, the executor calls `resolveOutcome(phase,
outcome)` and pattern-matches on the returned `OutcomeAction`:

- `advance` — proceed to the next phase
- `retry` — re-run the same phase up to `maxAttempts` times
- `revision` — schedule another revision cycle (re-implement → re-evaluate)
- `abort` — terminate the pipeline (still runs `retrospective`)
- `skip-to` — jump forward, emitting a warning
- `surface` — bubble to a human; do not auto-recover

## Phase: scout

The scout is advisory and runs before any code is written. Every failure mode
routes to the implementer with a warning rather than aborting — the
implementer's prompt builder degrades gracefully when no scout findings are
available.

| Outcome               | Condition                                                    | Action                                 | Rationale                                         |
| --------------------- | ------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------- |
| `success`             | Scout returned validated findings                            | `advance` → `implement`                | Happy path.                                       |
| `fail-timeout`        | Scout exceeded its wall-clock budget                         | `skip-to` → `implement` (with warning) | Scout is non-blocking — proceed without findings. |
| `fail-agent-protocol` | Scout `AGENT_RESULT` malformed or findings failed validation | `skip-to` → `implement` (with warning) | Scout is non-blocking — proceed without findings. |
| `abort-user`          | User-initiated abort                                         | `abort`                                | Honour the explicit user signal.                  |

## Phase: implement

| Outcome                | Condition                                                          | Action               | Rationale                                                                      |
| ---------------------- | ------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------ |
| `success`              | Implementer completed with non-empty diff and valid `AGENT_RESULT` | `advance` → `verify` | Happy path.                                                                    |
| `fail-test`            | Pre-flight test command non-zero                                   | `retry` × 1          | Cheap to re-run with adjusted prompt; `analyzeFailure` decides viability.      |
| `fail-type-error`      | TS / type-check failure                                            | `retry` × 1          | Same as `fail-test` — model often fixes on second attempt.                     |
| `fail-lint`            | Linter rejected the diff                                           | `retry` × 1          | Same as `fail-test`.                                                           |
| `fail-build`           | Project build step failed                                          | `retry` × 1          | Same as `fail-test`.                                                           |
| `fail-timeout`         | Agent exceeded wall-clock budget                                   | `abort`              | A timed-out implementer leaves indeterminate state — don't verify.             |
| `fail-agent-protocol`  | `AGENT_RESULT` malformed or missing                                | `abort`              | Cannot trust downstream phases without structured output.                      |
| `fail-no-code-changes` | Agent finished cleanly but produced an empty diff                  | `abort`              | Verifier has nothing to exercise — don't waste the budget on text-only output. |
| `abort-user`           | User-initiated abort (Ctrl+C, attended-mode prompt)                | `abort`              | Honour the explicit user signal.                                               |

## Phase: verify

| Outcome                 | Condition                                                | Action                  | Rationale                                                           |
| ----------------------- | -------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------- |
| `success`               | Verifier rubric all-pass                                 | `advance` → `review`    | Happy path.                                                         |
| `fail-test`             | Behavioural test fails in the verifier rubric            | `revision` (next cycle) | Implementer should fix; cheaper than aborting.                      |
| `fail-evidence-missing` | No screenshot / test-output / scenario artifact recorded | `revision` (next cycle) | Verifier cannot prove the change; re-implement with evidence focus. |
| `fail-soft-findings`    | Verifier rubric `fail` on non-critical categories        | `revision` (next cycle) | Same path — implementer addresses the rubric findings.              |
| `fail-timeout`          | Verifier agent exceeded wall-clock budget                | `abort`                 | Indeterminate verification result — block PR.                       |
| `fail-agent-protocol`   | Verifier `AGENT_RESULT` malformed                        | `abort`                 | Cannot route findings without structured rubric.                    |
| `abort-user`            | User-initiated abort                                     | `abort`                 | Honour the explicit user signal.                                    |

## Phase: review

| Outcome                  | Condition                                                                                               | Action                             | Rationale                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `success`                | Reviewer rubric all-pass, no critical findings                                                          | `advance` → `close`                | Happy path.                                                      |
| `fail-critical-findings` | Reviewer `findings.critical > 0` OR hard rubric category fail (principle-compliance / scope-discipline) | `abort`                            | Architectural truth — never auto-recovered.                      |
| `fail-soft-findings`     | Reviewer rubric `fail` on soft categories (test-sufficiency / pattern-fit)                              | `revision` (next cycle)            | Implementer addresses the soft findings.                         |
| `budget-exhausted`       | Reviewer wants another revision but cycle budget is spent                                               | `skip-to` → `close` (with warning) | Pragmatic: ship with the warning surfaced in the PR description. |
| `fail-timeout`           | Reviewer agent exceeded wall-clock budget                                                               | `abort`                            | Indeterminate review — block PR.                                 |
| `fail-agent-protocol`    | Reviewer `AGENT_RESULT` malformed                                                                       | `abort`                            | Cannot route findings without structured rubric.                 |
| `abort-user`             | User-initiated abort                                                                                    | `abort`                            | Honour the explicit user signal.                                 |

## Phase: close

| Outcome                   | Condition                               | Action                      | Rationale                                                   |
| ------------------------- | --------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| `success`                 | PR opened or updated                    | `advance` → `retrospective` | Happy path.                                                 |
| `fail-github-unreachable` | `gh` CLI / GitHub API transient failure | `retry` × 1                 | Transient network or rate-limit; one bounded retry.         |
| `fail-agent-protocol`     | Closer `AGENT_RESULT` malformed         | `surface` (manual)          | A partially-created PR may exist; require human inspection. |
| `fail-timeout`            | Closer agent exceeded wall-clock budget | `surface` (manual)          | PR may be partially created — never silently retry.         |
| `abort-user`              | User-initiated abort                    | `abort`                     | Honour the explicit user signal.                            |

## Phase: retrospective

The retrospective **never blocks the pipeline**. Every failure mode here
becomes a non-fatal warning so the run can still report `complete`.

| Outcome               | Condition                              | Action                                | Rationale                                                      |
| --------------------- | -------------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `success`             | Retrospective agent completed          | `advance` → `complete`                | Happy path.                                                    |
| `fail-timeout`        | Retrospective exceeded its budget      | `skip-to` → `complete` (with warning) | Learnings update missed, but the pipeline result is unchanged. |
| `fail-agent-protocol` | Retrospective `AGENT_RESULT` malformed | `skip-to` → `complete` (with warning) | Same — never block on retrospective.                           |

## Adding a new outcome

1. Add the variant to the `OutcomeKind` union in [`src/types.ts`](../src/types.ts).
2. Add it to `ALL_OUTCOMES` and to every applicable phase in
   `APPLICABLE_OUTCOMES` inside [`src/dag/outcome-table.ts`](../src/dag/outcome-table.ts).
3. Add the matrix entry (or entries) — every applicable pair needs one.
4. Update the table above in this document.
5. Re-run `bun test ./src/__tests__/outcome-table.spec.ts` — the
   exhaustiveness tests will fail until every applicable pair is wired up.
