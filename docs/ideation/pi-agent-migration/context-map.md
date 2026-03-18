# Context Map: Pi Agent Migration

**Phase**: 1
**Scout Confidence**: 87/100
**Verdict**: GO

## Dimensions

| Dimension | Score | Notes |
|---|---|---|
| Scope clarity | 19/20 | All files identified: 4 new, 7 modified, 2 deleted. Clear interface boundaries. |
| Pattern familiarity | 18/20 | `agent-runner.ts` is the primary pattern — same `spawnAgent` signature, different engine. |
| Dependency awareness | 18/20 | 5 phase files import `spawnAgent`, test mock in `mocks.ts`. Pipeline loop unchanged. |
| Edge case coverage | 15/20 | Core cases clear. Pi-specific edge cases (AbortController support, event types) need verification at build time. |
| Test strategy | 17/20 | bun:test with mock.module for I/O boundaries. Existing `implement-phase.spec.ts` shows exact mocking pattern. |

## Key Patterns

- `src/agent-runner.ts` — Core pattern: `spawnAgent(options: SpawnAgentOptions): Promise<SpawnAgentResult>`. Uses heartbeat via `setInterval`, parses result via `parseAgentResult`, wraps errors in synthetic `AgentResult`.
- `src/util/parse-frontmatter.ts` — Being replaced. Currently parses YAML frontmatter for `tools`, `model`, `name`, `description` from agent `.md` files.
- `src/__tests__/mocks.ts` — Global mocks via `mock.module`. Mocks `spawnAgent` at `../agent-runner.js` path, `runScript`, `writeRunMetrics`, `prompt-tracker`.
- `src/__tests__/implement-phase.spec.ts` — Shows mock setup, `makeConfig()` helper, `makeMockStore()` pattern, `completedResult`/`failedResult` fixtures.

## Dependencies

- `src/agent-runner.ts:21` (spawnAgent) — consumed by → `phases/implement.ts`, `phases/verify.ts`, `phases/review.ts`, `phases/close.ts`, `phases/retrospective.ts`
- `src/util/parse-frontmatter.ts:32` (loadAgentMetadata) — consumed by → `src/agent-runner.ts` only
- `src/types.ts:112` (SpawnAgentOptions) — consumed by → `agent-runner.ts`, all phase files (via spawnAgent)
- `src/__tests__/mocks.ts:14` — mocks `../agent-runner.js` path — must update when import path changes

## Conventions

- **Naming**: Files use kebab-case. Functions use camelCase. Types use PascalCase.
- **Imports**: Relative paths with `.js` extension (Node16 moduleResolution). No barrel exports.
- **Error handling**: `spawnAgent` returns synthetic failed `AgentResult` on error (never throws). Phases check `result.status`.
- **Types**: Interfaces preferred. Types in `src/types.ts`. `AgentName` union for pipeline agents.
- **Testing**: `src/__tests__/*.spec.ts`. bun:test framework. Global mocks via `mocks.ts` preloaded by bunfig.toml. Mock I/O boundaries only.

## Risks

- **Mock path update**: `mocks.ts` mocks `'../agent-runner.js'`. Changing to `'../agent/pi-runner.js'` affects ALL existing tests that use `mockSpawnAgent`. Must update atomically.
- **Pi package availability**: `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent` must be installable via bun. If packages aren't on npm, the spec's install step will fail.
- **Event subscription API**: The spec assumes `agent.subscribe()` with `event.type === "message_update"` and `event.type === "tool_execution_start"`. Actual Pi API may differ — verify at build time.
- **`background` field removal**: `SpawnAgentOptions.background` is used in `agent-runner.ts` logging but not passed through. Safe to remove, but check no phase passes it.
