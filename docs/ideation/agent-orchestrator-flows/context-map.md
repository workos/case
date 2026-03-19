# Context Map: Agent Orchestrator Flows

**Phase**: 1
**Scout Confidence**: 87/100
**Verdict**: GO

## Dimensions

| Dimension | Score | Notes |
|---|---|---|
| Scope clarity | 18/20 | 3 new files, 2 modified files, all with detailed implementation steps in spec. Only ambiguity: depth of re-entry logic (spec flags this as an open item). |
| Pattern familiarity | 19/20 | All 4 existing tool files read, CLI orchestrator flow read, SKILL.md read. Naming, structure, imports, TypeBox usage, ToolDefinition shape all clear. |
| Dependency awareness | 17/20 | `orchestrator-session.ts` consumed by `src/index.ts:9` and `src/__tests__/orchestrator-session.spec.ts`. `types.ts` widely imported but changes are additive. Orchestrator-session test checks `customTools.length === 4` which must become 5. |
| Edge case coverage | 15/20 | Spec lists 6 error scenarios. SKILL.md covers re-entry semantics, stale tasks, branch recovery. Gaps: streaming behavior during long phases, partial phase failure with multiple specs, filesystem permission errors. |
| Test strategy | 18/20 | bun:test framework with `mock.module()` pattern. `bunfig.toml` preloads `mocks.ts` for global I/O boundary mocks. `pipeline-tool.spec.ts` is a near-identical analog. Commands: `bun run typecheck && bun test`. |

## Key Patterns

- `src/entry/cli-orchestrator.ts` — Deterministic step-by-step orchestration flow. Pattern: detect repo, check re-entry, create task, run baseline, dispatch. Uses `runScript()` for shell, `createTask()` for task files, `Bun.spawn` for git. Error handling via early returns and `process.exit(1)`.

- `src/agent/tools/pipeline-tool.ts` — Canonical ToolDefinition wrapper. Pattern: import `Type` from `@sinclair/typebox`, define params as `Type.Object({...})`, export `createXTool(caseRoot)` returning `ToolDefinition<typeof params>`. Execute signature: `async (_toolCallId, params, _signal, onUpdate, _ctx)`. Returns `{ content: [{type: 'text', text: ...}], details: {...} }`. Progress via `onUpdate?.({content: [...], details: {...}})`.

- `skills/from-ideation/SKILL.md` — The logic being ported. Key flow: load contract.md, discover spec files, create task with `issueType: "ideation"` and `contractPath`, branch `feat/{project-name}`, per-phase implementer spawning, full validation, verifier/reviewer/closer, retrospective. Re-entry via `contractPath` match in `tasks/active/*.task.json`.

- `src/agent/tools/issue-tool.ts`, `task-tool.ts`, `baseline-tool.ts` — Additional tool examples confirming the pattern: thin wrappers, TypeBox params, caseRoot closure, consistent return shape.

## Dependencies

- `src/agent/orchestrator-session.ts:57-62` (customTools array) — consumed by `src/index.ts:9`, `src/__tests__/orchestrator-session.spec.ts:71`
  - **CRITICAL**: Test asserts `customTools.length === 4` and checks for 4 tool names. Adding `run_from_ideation` makes it 5. This test MUST be updated.

- `src/agent/orchestrator-session.ts:123-149` (buildOrchestratorSystemPrompt) — consumed internally, tested via `orchestrator-session.spec.ts` (checks prompt contains caseRoot)

- `src/types.ts` — consumed by 20+ files. Changes are additive (new interfaces) so no blast radius.

- `src/agent/from-ideation.ts` (new) — will import from: `./pi-runner.js`, `../entry/task-factory.js`, `../util/run-script.js`, `./prompt-loader.js`, `../util/parse-agent-result.js`, `../types.js`

- `src/agent/tools/from-ideation-tool.ts` (new) — will import from: `../from-ideation.js`, `../../entry/repo-detector.js`

## Conventions

- **Naming**: Tool files: `{name}-tool.ts` in `src/agent/tools/`. Factory: `create{Name}Tool(caseRoot)`. Tool names: `snake_case`. Test files: `{name}.spec.ts` in `src/__tests__/`.
- **Imports**: Relative paths with `.js` extension. `node:path`, `node:fs/promises` for stdlib. `@sinclair/typebox` for params. Types via `type` keyword.
- **Error handling**: Tool wrappers let errors propagate. Core modules return structured results (never throw for expected failures).
- **Types**: Interfaces preferred. Named exports. Shared types in `src/types.ts`. Module-local interfaces in-file.
- **Testing**: bun:test. `mock()` for function mocks, `mock.module()` for module mocks. Mocks before dynamic `await import()`. Global I/O mocks in `src/__tests__/mocks.ts` (preloaded via bunfig.toml).

## Risks

- **Orchestrator session test must update tool count**: Test asserts 4 tools, must change to 5.
- **Re-entry logic complexity**: `task-scanner.ts` has no `findTaskByContractPath()` — must implement inline or extract. Spec flags re-entry as potentially deferrable.
- **Global mock preload**: New test must use `mockSpawnAgent` and `mockRunScript` from `./mocks.js`, not re-declare.
- **System prompt token budget**: Spec says under 1500 tokens. Current is ~150 words. Must count after writing.
