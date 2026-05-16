# Context Map: pipeline-v2

**Phase**: 2 (current) | Phase 1 (prior)
**Scout Confidence**: 88/100 (Phase 2) | 87/100 (Phase 1)
**Verdict**: GO

## Dimensions

### Phase 2 (current)

| Dimension            | Score | Notes                                                                                                                                                                                                |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | 19/20 | All 10 new files and 3 modified files enumerated; rule YAMLs have full bodies in spec.                                                                                                               |
| Pattern familiarity  | 14/20 | No prior ast-grep usage in repo. Spec includes complete YAML examples.                                                                                                                               |
| Dependency awareness | 19/20 | New files are self-contained. Modified files have no downstream code consumers. Zero TS blast radius.                                                                                                 |
| Edge case coverage   | 18/20 | False positive on `console.error`/`console.warn` explicitly handled. Known `Bun.spawn(['open'...])` at `approve-server.ts:97`.                                                                       |
| Test strategy        | 18/20 | Test harness is shell-script with `jq` filter. Bun test infrastructure unaffected.                                                                                                                    |

### Phase 1 (prior)

| Dimension            | Score | Notes                                                                                                                                                                                                          |
| -------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope clarity        | 18/20 | All 15 new files, 9 modified, 4 deleted enumerated with file-level guidance. Minor ambiguity: spec says `tests/events/...` while project convention is `src/__tests__/*.spec.ts`.                              |
| Pattern familiarity  | 18/20 | All three pattern files read: `src/tracing/types.ts` (TraceEvent union), `src/tracing/writer.ts` (TraceWriter NDJSON buffered append), `src/agent/pi-runner.ts` (current spawnAgent).                          |
| Dependency awareness | 18/20 | All consumers mapped via grep. `TraceWriter`/`TraceEvent` referenced only in 9 src files; `MetricsCollector` in 5; `spawnAgent` in 12; `getToolsForAgent` only in 3.                                           |
| Edge case coverage   | 17/20 | Crash mid-write, invalid transitions, corrupted trailing line, unknown event type, projection lock all enumerated in spec's Failure Modes table.                                                               |
| Test strategy        | 16/20 | Bun test (`bun test`), `bunfig.toml` preloads module mocks. `bun test --filter <name>` for scoping. Phase pattern of dispatching mocks via `mocks.ts` clear; test directory convention conflict noted as risk. |

## Key Patterns

- `src/tracing/types.ts` — Discriminated union pattern on `event` field with shared `ts`/`phase`/`agent` envelope. New `PipelineEvent` should extend by adding `sequence: number` and `runId: string` to envelope and add lifecycle variants (`pipeline_start`, `phase_start`, `phase_end` with `result?`, `revision_requested`, `revision_budget_exhausted`, `status_changed`, `marker_written`, `pipeline_end`). Existing `tool_start`/`tool_end` variants must remain field-compatible for backward compat with `jq`/`grep` analysis.

- `src/tracing/writer.ts` — Buffered NDJSON append pattern: lazy `mkdir` via `dirReady` Promise, `buffer: string[]`, `write()` buffers, `flush()` joins with `\n` and `appendFile`s. File path layout `.case/<task-slug>/traces/run-<runId>.jsonl` — `EventAppender` will use `.case/<task-slug>/events/run-<runId>.jsonl`. Spec adds: validate-before-write, sequence assignment, in-memory state via `reduceEvents`, post-write projection calls.

- `src/agent/pi-runner.ts` — Single exported `spawnAgent(options): Promise<SpawnAgentResult>`. Imports `Agent`, `streamSimple`, `ModelRegistry`, `AuthStorage` from three `@mariozechner/pi-*` packages plus `createReadTool`/etc via `tool-sets.ts`. Module-level `registry = new ModelRegistry(AuthStorage.create())`. Wires tracing via `agent.subscribe()` callback that filters `tool_execution_start`/`tool_execution_end` events. Timeout via `setTimeout(() => agent.abort(), timeout)`. `PiRuntimeAdapter.spawn()` will absorb this entire body; `createTools()` absorbs `getToolsForAgent` from `src/agent/tool-sets.ts:4-15`.

## Dependencies

- `src/tracing/writer.ts` — consumed by → `src/pipeline.ts`, `src/types.ts` (type-only), `src/agent/pi-runner.ts`, `src/phases/{implement,verify,review,close,retrospective}.ts`
- `src/tracing/types.ts` — consumed by → `src/tracing/writer.ts` only
- `src/metrics/collector.ts` — consumed by → `src/pipeline.ts`, `src/__tests__/mocks.ts`, `src/__tests__/metrics-collector.spec.ts`, `src/phases/retrospective.ts` (imports `MetricsSnapshot` type)
- `src/metrics/writer.ts` — consumed by → `src/pipeline.ts`, `src/__tests__/mocks.ts`
- `src/agent/pi-runner.ts` (`spawnAgent`) — consumed by → `src/phases/{implement,verify,review,close,retrospective}.ts`, `src/agent/from-ideation.ts`, mocked in `src/__tests__/mocks.ts`
- `src/agent/tool-sets.ts` (`getToolsForAgent`) — consumed by → `src/agent/pi-runner.ts`, `src/__tests__/pi-runner.spec.ts`
- `src/state/task-store.ts` (`TaskStore`) — consumed by → all phase modules, pipeline.ts, evidence-assembler, from-ideation, multiple tests
- `src/state/transitions.ts` (`determineEntryPhase`) — consumed by → `src/pipeline.ts`, `src/entry/task-scanner.ts`
- `src/notify.ts` — no consumer changes; spec explicitly says "no changes."

## Conventions

- **Naming**: snake_case event `event` field values (`tool_start`, `phase_end`); camelCase TS fields; PascalCase types/classes; kebab-case filenames; `*.spec.ts` for tests under `src/__tests__/`.
- **Imports**: ESM with explicit `.js` extension on relative imports (`"type": "module"`); `import type { ... }` for type-only imports; Pi SDK imports via `@mariozechner/*` must stay confined to `src/agent/adapters/pi-adapter.ts`.
- **Error handling**: Throw typed Error subclasses (`TaskStateError` pattern in `task-store.ts`); `LifecycleValidationError` follows same pattern.
- **Types**: `interface` for object shapes, `type` for unions/aliases; discriminated unions on a literal field; explicit `null` over `undefined` in JSON-serialized fields.
- **Testing**: Bun test, `bunfig.toml` declares `[test] preload` and `root = "./src/__tests__"`. Test files: `src/__tests__/<name>.spec.ts`. Module-level mocks in `mocks.ts` via `mock.module()`.

## Risks

- **Test directory convention conflict** — Spec lists tests at `tests/events/reducer.test.ts` etc., but project convention is `src/__tests__/*.spec.ts` with `bunfig.toml [test] root = "./src/__tests__"`. Tests outside this root won't be picked up. Resolution: place files at `src/__tests__/events-*.spec.ts`.
- **`mark-tested.sh`/`mark-reviewed.sh` not in TS** — Spec says remove invocations from verify.ts/review.ts but those scripts are invoked by agent prompts, not phase TS. The "remove invocation" bullet is a no-op for TS.
- **`MetricsCollector` consumer in retrospective** — `src/phases/retrospective.ts` imports `MetricsSnapshot` type. After replacing `MetricsCollector` with `projectMetrics()`, retrospective needs updated.
- **`pipeline.ts` blast radius** — 449 lines with heavy intermixed logic. Verify pipeline.spec.ts after each major refactor step.
- **`PipelineConfig` lacks `profile`** — `generatePlan(task, config)` needs profile; profile lives on `task.profile`, not `config`. Use `task.profile` directly.
