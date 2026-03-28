# Context Map: Harness 2.0

**Phase**: 5 (extends phase 3)
**Scout Confidence**: 85/100
**Verdict**: GO

## Dimensions

| Dimension | Score | Notes |
|---|---|---|
| Scope clarity | 18/20 | All 4 modified files read. Changes are additive: new interface `EvaluatorEffectiveness`, new fields on `RunMetrics`, new methods on `MetricsCollector`, new metric collection calls in `pipeline.ts`, new signal rows in `retrospective.md`. One ambiguity: `revisionCycles` and `addRevisionCycle()` already exist (Phase 3) -- builder must not duplicate. |
| Pattern familiarity | 18/20 | Existing `setCiFirstPush()`, `setReviewFindings()` pattern in collector.ts (lines 46-58) is the exact pattern for new methods. `metrics.setCiFirstPush()` calls in pipeline.ts (line 114) are the exact pattern for new integration points. |
| Dependency awareness | 17/20 | `RunMetrics` consumed by 6 files but only `writer.ts` destructures specific fields. Adding fields is non-breaking. `writer.ts` selectively picks fields -- new fields will NOT appear in JSONL log unless writer is also updated. Spec does not list writer.ts as modified -- intentional deferral. |
| Edge case coverage | 16/20 | Spec covers defaults well. Edge cases: (1) `revisionFixedIssues` logic spans multiple branches. (2) Rubric capture must handle undefined rubric. (3) `addSkippedPhase` must go before `continue`. (4) Human override only in review case. |
| Test strategy | 16/20 | Existing test file `src/__tests__/metrics-collector.spec.ts` has strong patterns. Spec says tests go in wrong path -- must add to existing file. |

## Key Patterns

- `src/metrics/collector.ts:46-58` — setter pattern: private field, public setter, included in `finalize()`.
- `src/pipeline.ts:112-115` — pipeline integration: access `output.result`, call metrics method.
- `src/__tests__/metrics-collector.spec.ts:88-98` — test pattern: create collector, call method, finalize, assert.
- `agents/retrospective.md:73-82` — classification table: markdown table with signal/fix/example columns.
- `src/types.ts:247-260` — RunMetrics: JSDoc on each field, sub-interfaces defined nearby.

## Dependencies

- `src/types.ts` — consumed by 35+ files. Additive only. Non-breaking.
- `src/metrics/collector.ts` — consumed by pipeline.ts and metrics-collector.spec.ts. New methods additive.
- `src/pipeline.ts` — consumed by pipeline.spec.ts. Only `runPipeline` exported; signature unchanged.
- `agents/retrospective.md` — consumed at runtime as prompt. Additive markdown rows.
- `src/metrics/writer.ts` — NOT modified. New fields silently absent from JSONL until updated.

## Conventions

- **Naming**: kebab-case files, `.spec.ts` in `src/__tests__/`, PascalCase interfaces, camelCase fields/methods.
- **Imports**: Relative paths with `.js` extensions, `type` keyword for type-only imports.
- **Types**: All in `src/types.ts`. Interfaces preferred. JSDoc on interfaces and fields.
- **Testing**: bun:test, `describe` > `beforeEach` > `it` blocks, assert on `finalize()` output.
- **Metrics pattern**: Private fields with defaults, public setter/increment methods, all in `finalize()`.

## Risks

- **Test file path mismatch**: Spec says `src/metrics/collector.test.ts`. Must use existing `src/__tests__/metrics-collector.spec.ts`.
- **`revisionCycles`/`addRevisionCycle()` already exist**: Phase 3 implemented these. Don't duplicate.
- **`addSkippedPhase` call site**: Must insert before `continue` in profile-skip block (pipeline.ts:66-70).
- **Human override tracking**: Only review case has "Override and continue" (pipeline.ts:189).
- **`revisionFixedIssues` spans branches**: `true` case in clean-pass after revision, `false` in budget-exhausted.
- **Rubric capture**: Should happen in all branches where `output.result.rubric` is available.
- **`writer.ts` not updated**: New fields silently absent from JSONL log.
