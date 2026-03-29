# Context Map: approval-gate

**Phase**: 3
**Scout Confidence**: 87/100
**Verdict**: GO

## Dimensions

| Dimension | Score | Notes |
|---|---|---|
| Scope clarity | 18/20 | All 11 files clearly identified with specific changes. The spec is extremely detailed with code snippets for most changes. Minor ambiguity: the spec says to add `/api/ready` endpoint but the current `approve-server.ts` already shuts down after decision (line 90) -- the manual edit flow needs the server to stay alive, which means the current architecture (single promise → stop) must be restructured. |
| Pattern familiarity | 18/20 | Both pattern files read: `revision.ts` (15 lines, simple factory) and `MetricsCollector` (157 lines, private fields + public methods + finalize pattern). Codebase conventions are consistent and well-understood. |
| Dependency awareness | 18/20 | Full dependency map built. `approve.ts` consumed only by `pipeline.ts`. `approve-server.ts` consumed only by `approve.ts`. `MetricsCollector` consumed by `pipeline.ts` and `retrospective.ts` (via `MetricsSnapshot`). `assembler.ts` consumed by all four phase modules + test. `types.ts` consumed by ~30 files but changes are additive (new fields on existing interfaces). `writer.ts` consumed only by `pipeline.ts`. |
| Edge case coverage | 16/20 | Spec covers: empty feedback, user never clicks Ready, manual edits break tests, maxRevisionCycles exceeded by human. Remaining gaps: what if the approval server port is reused between decide and ready (unlikely but possible); what if the browser tab is closed during manual edit waiting state (no WebSocket, so no detection -- user must use Ready button or Ctrl+C). |
| Test strategy | 17/20 | Test infra well understood: `bun:test`, preloaded mocks in `bunfig.toml`, `mock.module` for I/O boundaries. Existing tests cover approve/reject/revise basics. New tests need to cover: manual edit flow, `approving→verifying` transition, human feedback in assembler context, approval metrics. The pipeline test file is large (~957 lines) and uses a pattern of sequential `mockSpawnAgent` chaining. `mockRunApprovalServer` is already wired in both test files. |

## Key Patterns

- `src/phases/revision.ts` -- Simple factory: creates `RevisionRequest` with `source`, `failedCategories`, `summary`, `suggestedFocus`, `cycle: 0` (pipeline overwrites cycle). The approve phase should follow this same structure for human-sourced revisions: `source: 'human'`, empty `failedCategories`, human text as `summary`, empty `suggestedFocus`.

- `src/metrics/collector.ts` -- Class with private fields + public setter methods + `finalize()` that returns `RunMetrics`. Pattern for new metrics: add private field with default, add public setter method, include in `finalize()` return object. The `snapshot()` method returns a subset for retrospective -- new approval fields likely don't need to be in the snapshot.

## Dependencies

- `src/phases/approve.ts` -- consumed by `pipeline.ts` (import), `src/__tests__/approve-phase.spec.ts` (dynamic import after mock)
- `src/phases/approve-server.ts` -- consumed by `src/phases/approve.ts` (import), mocked in both test files
- `src/phases/approve-ui.ts` -- consumed by `src/phases/approve-server.ts` (import)
- `src/pipeline.ts` -- consumed by `src/__tests__/pipeline.spec.ts` (dynamic import), `src/index.ts`
- `src/context/assembler.ts` -- consumed by `src/phases/implement.ts`, `src/phases/verify.ts`, `src/phases/review.ts`, `src/phases/close.ts`, `src/__tests__/assembler.spec.ts`
- `src/metrics/collector.ts` -- consumed by `src/pipeline.ts`, `src/phases/retrospective.ts` (MetricsSnapshot type), `src/__tests__/metrics-collector.spec.ts`
- `src/types.ts` -- consumed by ~30 files. Changes are additive (new optional fields on `RunMetrics`, new value in `STATUS_TRANSITIONS`).
- `src/metrics/writer.ts` -- consumed by `src/pipeline.ts`, mocked in test preload

## Conventions

- **Naming**: Files use kebab-case (`approve-server.ts`). Types use PascalCase. Functions use camelCase. Test files end in `.spec.ts` and live in `src/__tests__/`.
- **Imports**: Relative paths with `.js` extension (TypeScript ESM convention). `type` keyword used for type-only imports. No barrel exports.
- **Error handling**: Phases return `PhaseOutput` with `nextPhase: 'abort'` for failures rather than throwing. Logger (`createLogger()`) used for structured logging. `log.phase(phaseName, event, data?)` pattern.
- **Types**: Interfaces preferred (`interface RunMetrics`, not `type RunMetrics`). Union types for status literals. Types centralized in `src/types.ts`.
- **Testing**: `bun:test` framework. `describe/it/expect/mock/beforeEach`. Mocks via `mock.module()` for I/O boundaries. Tests import `./mocks.js` for shared mocks (preloaded via bunfig.toml). Dynamic `await import()` after mock setup. `makeConfig()` helper pattern with `Partial<PipelineConfig>` overrides.

## Risks

- **`approve-server.ts` architecture change for manual edit flow**: The current server creates one promise (`decisionPromise`), resolves it on `/api/decide`, then immediately calls `server.stop()`. The manual edit flow requires: (1) `/api/decide` resolves with `manualEdit: true`, (2) server stays alive, (3) new `/api/ready` endpoint resolves a second promise. This is a structural change to the server lifecycle.

- **`STATUS_TRANSITIONS` needs `'verifying'` added to `approving`**: Currently `approving: ['closing', 'implementing']`. The `walkStatusToPhase` BFS depends on this being correct -- if `'verifying'` is missing, the status walk from `approving` to `verifying` will fail silently.

- **`RunMetrics` interface change affects `writeRunMetrics`**: Adding fields to `RunMetrics` in `types.ts` means `finalize()` in collector must return them, and `writeRunMetrics` in `writer.ts` must serialize them. Both must stay in sync.

- **Assembler's `buildRevisionContext` change**: Currently formats all revision sources the same way. For `source: 'human'`, both `failedCategories` and `suggestedFocus` arrays are empty, so output would have empty headers. The spec says to branch on `source === 'human'` with different formatting.

- **Pipeline approve case already partially implements Phase 3 logic**: Lines 308-318 of `pipeline.ts` already handle `nextPhase === 'implement'` with revision from the approve phase. The builder needs to add metrics calls here but must not break existing logic.
