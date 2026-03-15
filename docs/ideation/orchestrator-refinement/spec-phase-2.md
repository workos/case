# Implementation Spec: Orchestrator Refinement - Phase 2

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Rewrite `agent-runner.ts` to use `claude` CLI exclusively. Drop the Agent SDK path entirely. Parse agent `.md` frontmatter for tool restrictions and pass them via `--allowedTools`. Use `--output-format stream-json` for structured output that can be parsed for AGENT_RESULT. Add `--worktree` for git isolation.

Also add a `create` subcommand to `src/index.ts` that delegates to the existing `task-factory.ts`, giving a CLI path for task creation without needing the HTTP server.

Remove `@anthropic-ai/claude-agent-sdk` from `package.json`.

## Feedback Strategy

**Inner-loop command**: `bun test`

**Playground**: Test suite — most changes are to internal modules with existing test coverage.

**Why this approach**: agent-runner.ts is tested via mocks in phase tests. The frontmatter parser is pure logic, easy to unit test. The create command is a thin wrapper around task-factory.ts which already has tests.

## File Changes

### New Files

| File Path                                 | Purpose                                         |
| ----------------------------------------- | ----------------------------------------------- |
| `src/util/parse-frontmatter.ts`           | Extract YAML frontmatter from agent `.md` files |
| `src/__tests__/parse-frontmatter.spec.ts` | Tests for frontmatter parser                    |

### Modified Files

| File Path                | Changes                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `src/agent-runner.ts`    | Remove SDK path. Rewrite CLI path with --worktree, --allowedTools, --output-format. Parse frontmatter for agent metadata. |
| `src/types.ts`           | Add `AgentMetadata` interface. Add `agentName` to `SpawnAgentOptions`.                                                    |
| `src/index.ts`           | Add `create` subcommand with --repo, --title, --description flags.                                                        |
| `src/__tests__/mocks.ts` | Update spawnAgent mock if signature changes.                                                                              |
| `package.json`           | Remove `@anthropic-ai/claude-agent-sdk` from dependencies.                                                                |

## Implementation Details

### 1. Frontmatter Parser

**Pattern to follow**: Simple regex-based extraction — no YAML library needed. Agent frontmatter is simple key-value with one array field.

**Overview**: Parse the `---` delimited YAML frontmatter from agent `.md` files. Extract `name`, `description`, `tools`, and optional `model` fields.

```typescript
export interface AgentMetadata {
  name: string;
  description: string;
  tools: string[];
  model?: string;
}

export function parseFrontmatter(content: string): AgentMetadata;
export async function loadAgentMetadata(agentPath: string): Promise<AgentMetadata>;
```

**Key decisions**:

- Regex-based, not a YAML library — the frontmatter is simple enough that `tools: ['Read', 'Edit']` can be parsed with a regex
- Cache loaded metadata in a module-level Map keyed by agent name — frontmatter doesn't change during a pipeline run
- Validate required fields (name, tools) and throw if missing

**Implementation steps**:

1. Extract content between first `---` pair
2. Parse `name:` and `description:` as string values
3. Parse `tools:` as a JSON-like array (the format is `['Read', 'Edit', ...]`)
4. Parse optional `model:` as string
5. Export `loadAgentMetadata(path)` that reads file + parses + caches

**Feedback loop**:

- **Playground**: Create `src/__tests__/parse-frontmatter.spec.ts` with test cases
- **Experiment**: Test with each real agent `.md` file content (implementer has 6 tools, verifier has 4, etc.)
- **Check command**: `bun test src/__tests__/parse-frontmatter.spec.ts`

### 2. Agent Runner Rewrite

**Pattern to follow**: The existing `spawnViaCLI` function structure, but with proper flags.

**Overview**: Remove the SDK path. Rewrite CLI spawning to:

- Load agent metadata from frontmatter
- Build CLI args with `--print`, `--output-format`, `--allowedTools`, `--worktree`
- Parse structured output for AGENT_RESULT
- Handle timeouts via process kill

```typescript
export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const metadata = await loadAgentMetadata(options.agentPath);
  const args = buildCliArgs(options, metadata);
  const raw = await runClaude(args, options.cwd, options.timeout);
  const result = parseAgentResult(raw);
  return { raw, result, durationMs };
}
```

**Key decisions**:

- `--print` for non-interactive mode (agent runs to completion autonomously)
- `--output-format stream-json` for structured events — parse for text content blocks
- `--allowedTools` from agent frontmatter's `tools` array — each agent gets only what its `.md` declares
- `--worktree` for git isolation — each agent works in a temporary worktree
- `--model` from frontmatter if specified, otherwise use default
- `-p` flag receives the assembled prompt (from assembler.ts)
- Timeout via `setTimeout(() => proc.kill(), timeout)` — same as current approach
- `SpawnAgentOptions` gets a new required field: `agentName: AgentName` so the runner knows which `.md` to load

**Implementation steps**:

1. Remove `spawnViaSDK` function entirely
2. Remove dynamic `import('@anthropic-ai/claude-agent-sdk')`
3. Add `agentName` field to `SpawnAgentOptions`
4. In `spawnAgent`: load agent metadata, build CLI args, spawn process
5. Build args: `['claude', '--print', '-p', prompt, '--output-format', 'stream-json', '--allowedTools', ...metadata.tools]`
6. Add `--worktree` unless `options.background` is true (retrospective runs in background, may not need worktree)
7. Parse stdout: for stream-json format, extract text content from assistant message events
8. Run `parseAgentResult` on the extracted text (existing function, no changes needed)
9. Return `SpawnAgentResult` (same interface as today)

**Feedback loop**:

- **Playground**: Existing test mocks — `src/__tests__/mocks.ts` mocks `spawnAgent` at module level
- **Experiment**: `bun src/index.ts --task tasks/active/<file>.task.json --dry-run` to verify pipeline flow
- **Check command**: `bun test`

### 3. Type Updates

**Overview**: Add `AgentMetadata` interface and update `SpawnAgentOptions`.

```typescript
// New type
export interface AgentMetadata {
  name: string;
  description: string;
  tools: string[];
  model?: string;
}

// Updated type
export interface SpawnAgentOptions {
  prompt: string;
  cwd: string;
  agentName: AgentName; // NEW — which agent .md to load
  caseRoot: string; // NEW — needed to resolve agents/ directory
  timeout?: number;
  background?: boolean;
}
```

**Key decisions**:

- `agentName` is required, not optional — every spawn must declare which agent it represents
- `caseRoot` is needed so the runner can resolve `agents/{agentName}.md`
- `SpawnAgentResult` stays unchanged — the output format doesn't change

**Implementation steps**:

1. Add `AgentMetadata` interface
2. Add `agentName` and `caseRoot` to `SpawnAgentOptions`
3. Update all phase module `spawnAgent` calls to pass `agentName` and `config.caseRoot`

### 4. Phase Module Updates

**Overview**: Each phase module needs to pass `agentName` and `caseRoot` to `spawnAgent`. Minimal changes — just add two fields to the options object.

**Files**: `implement.ts`, `verify.ts`, `review.ts`, `close.ts`, `retrospective.ts`

**Change per file**: Add `agentName: '<role>'` and `caseRoot: config.caseRoot` to the `spawnAgent({ ... })` call.

Example for implement.ts:

```typescript
// Before
const { result } = await spawnAgent({ prompt, cwd: config.repoPath });

// After
const { result } = await spawnAgent({
  prompt,
  cwd: config.repoPath,
  agentName: 'implementer',
  caseRoot: config.caseRoot,
});
```

### 5. CLI Create Subcommand

**Pattern to follow**: Existing `runTask` and `runServe` functions in `src/index.ts`.

**Overview**: Add a `create` command that creates a task file pair via `task-factory.ts`. Minimal wrapper — just parse args and delegate.

```typescript
// Usage:
// bun src/index.ts create --repo cli --title "Fix auto-env" --description "..."
// bun src/index.ts create --repo cli --title "Fix auto-env" --description "..." --issue 42
```

**Key decisions**:

- `--repo` and `--title` are required
- `--description` is required (task factory needs it)
- `--issue` and `--issue-type` are optional
- `--mode` defaults to "attended"
- Output the created file paths so the user can immediately run the task

**Implementation steps**:

1. Add `create` to the `command` switch in `main()`
2. Add `runCreate(values)` function
3. Parse: `--repo`, `--title`, `--description` (required), `--issue`, `--issue-type`, `--mode` (optional)
4. Build `TaskCreateRequest` object with `trigger: { type: 'cli', user: 'local' }`
5. Call `createTask(caseRoot, request)`
6. Print created paths and a hint: `Run with: bun src/index.ts --task <path>`
7. Update `printUsage()` with the new subcommand
8. Add new flags to `parseArgs` options

**Feedback loop**:

- **Playground**: Run the command directly
- **Experiment**: `bun src/index.ts create --repo cli --title "test" --description "test desc"` then verify files exist
- **Check command**: `ls tasks/active/ | tail -1`

### 6. Remove SDK Dependency

**Overview**: Remove `@anthropic-ai/claude-agent-sdk` from `package.json` and reinstall.

**Implementation steps**:

1. Remove from `dependencies` in `package.json`
2. Run `pnpm install` to update lockfile
3. Verify `bun run typecheck` still passes (confirms no remaining imports)

### 7. Update Test Mocks

**Overview**: If `SpawnAgentOptions` signature changes (adding `agentName`, `caseRoot`), the mock in `mocks.ts` may need updating. Since mocks replace the entire module, the mock function just needs to accept the new fields without breaking.

**Implementation steps**:

1. Check if `mockSpawnAgent` in `mocks.ts` validates input fields — if so, update
2. Check if any test assertions reference `SpawnAgentOptions` shape — if so, update
3. Run `bun test` to verify

## Testing Requirements

### Unit Tests

| Test File                                 | Coverage                                       |
| ----------------------------------------- | ---------------------------------------------- |
| `src/__tests__/parse-frontmatter.spec.ts` | Frontmatter extraction from agent .md content  |
| `src/__tests__/implement-phase.spec.ts`   | Still passes with updated spawnAgent signature |
| `src/__tests__/pipeline.spec.ts`          | Still passes with updated mocks                |

**Key test cases for frontmatter parser**:

- Parse implementer.md frontmatter (6 tools)
- Parse verifier.md frontmatter (4 tools)
- Missing required field throws error
- No frontmatter returns error
- Optional `model` field parsed when present
- Optional `model` field absent returns undefined

**Key test cases for create subcommand**:

- Creates .task.json and .md files in tasks/active/
- Required flags missing prints error
- Generated task has correct repo, status: 'active', mode: 'attended'

### Manual Testing

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes
- [ ] `bun src/index.ts --help` shows create subcommand
- [ ] `bun src/index.ts create --repo cli --title "test" --description "test desc"` creates files
- [ ] `bun src/index.ts --task <created-file> --dry-run` completes pipeline
- [ ] No references to `@anthropic-ai/claude-agent-sdk` in `src/` directory

## Error Handling

| Error Scenario                | Handling Strategy                                             |
| ----------------------------- | ------------------------------------------------------------- |
| `claude` CLI not found        | Clear error: "claude CLI not found. Install from https://..." |
| Agent .md missing frontmatter | Throw with agent name and expected format                     |
| CLI exits non-zero            | Capture stderr, include in SpawnAgentResult.error             |
| Timeout exceeded              | Kill process, return failed result with "timeout after Xms"   |
| Create with invalid repo      | Validate against projects.json, print available repo names    |

## Validation Commands

```bash
# Type checking
bun run typecheck

# Linting
bun run lint

# Unit tests
bun test

# Dry-run pipeline
bun src/index.ts --task tasks/active/cli-1-auto-env-after-login.task.json --dry-run

# Create a test task
bun src/index.ts create --repo cli --title "test task" --description "test description"

# Verify no SDK references remain
grep -r "claude-agent-sdk" src/ package.json
```
