# Context Map: Harness 2.0

**Phase**: 3
**Scout Confidence**: 82/100
**Verdict**: GO

## Dimensions

| Dimension | Score | Notes |
|---|---|---|
| Scope clarity | 18/20 | All 6 modified files read. Changes are well-specified with full code snippets. Minor ambiguity: spec says new `revision?` param on `assemblePrompt` but 4 other callers (verify.ts, review.ts, close.ts, assembler.spec.ts) pass only 5 args — must remain compatible. |
| Pattern familiarity | 18/20 | `FailureAnalysis` pattern in types.ts (lines 125-133) read. Retry context pattern in implement.ts (lines 106-117) read. `handleFailure` branching in pipeline.ts (lines 249-260) read. Review hard-fail gating in review.ts (lines 69-77) read. All patterns are clear and well-established. |
| Dependency awareness | 17/20 | `pipeline.ts` consumed by 5 files but interface unchanged. `assemblePrompt` called by 4 phase files and 1 test — new optional param is backward compatible. `PhaseOutput` used by all 4 phase files and pipeline.ts — adding optional `revision?` field is non-breaking. `runImplementPhase` called only from pipeline.ts — signature change is contained. |
| Edge case coverage | 14/20 | Spec covers: budget exhaustion, regression loops, context bloat, revision+retry interaction. Gaps: (1) verify→revision→implement→verify→review→revision chain with shared counter. (2) dry-run mode should skip revision logic. (3) `pendingRevision` must survive while-loop iteration. |
| Test strategy | 15/20 | Test infra: bun:test with preloaded mocks. Existing pipeline.spec.ts and implement-phase.spec.ts provide strong patterns. No existing verify or review test files — must create new ones. Convention: `.spec.ts` in `src/__tests__/` (NOT `.test.ts` as spec suggests). |

## Key Patterns

- `src/types.ts:125-133` (`FailureAnalysis`) — Pattern for `RevisionRequest`: flat struct with source discriminant, category array, summary, cycle number.
- `src/phases/implement.ts:106-117` (retry context) — Pattern for revision context prepending: build multiline string, prepend to prompt.
- `src/pipeline.ts:106-131` (verify case handling) — Pattern for phase branching: check abort, then proceed. Revision adds branch between abort and clean-pass.
- `src/phases/review.ts:69-77` (rubric hard-fail gate) — Pattern for rubric inspection: filter categories by name and verdict.
- `src/metrics/collector.ts` — Pattern for metric tracking: methods set private fields, `finalize()` includes all in returned `RunMetrics`.

## Dependencies

- `src/types.ts` — consumed by 35 files. Changes are additive only.
- `src/pipeline.ts` — consumed by 5 files. Only `runPipeline(config)` exported; signature unchanged.
- `src/context/assembler.ts` — consumed by 4 phase files. New `revision?` param is optional.
- `src/phases/verify.ts` — consumed only by pipeline.ts. Return type gains optional `revision` field.
- `src/phases/review.ts` — consumed only by pipeline.ts. Return type gains optional `revision` field.
- `src/phases/implement.ts` — consumed only by pipeline.ts. Signature adds optional `revision?` param.
- `src/metrics/collector.ts` — consumed by pipeline.ts and metrics-collector.spec.ts.

## Conventions

- **Naming**: kebab-case files, `.spec.ts` suffix in `src/__tests__/`, PascalCase interfaces.
- **Imports**: Relative paths with `.js` extensions, `type` keyword for type-only imports.
- **Error handling**: Phase functions return `PhaseOutput` with `nextPhase: 'abort'`. No try/catch in phases.
- **Types**: All in `src/types.ts`. Interfaces preferred. JSDoc on interfaces and fields.
- **Testing**: Bun test, shared mocks in `src/__tests__/mocks.ts`, `mock.module()` + dynamic imports.

## Risks

- **Test file naming mismatch**: Spec says `.test.ts` but project uses `.spec.ts` in `src/__tests__/`.
- **`maxRevisionCycles` on PipelineConfig**: Must be optional with default, or breaks all callers.
- **`revisionCycles` on RunMetrics**: Must default to `0` in `finalize()`.
- **`pendingRevision` scope**: Must be declared outside the while loop.
- **Review re-entry chain**: reviewer revision → implement → verify → review. Shared counter must handle this.
- **No existing verify/review phase tests**: Must create from scratch following implement-phase.spec.ts pattern.
- **`assemblePrompt` signature**: New optional 6th param. Existing 5-arg callers remain compatible.
