# Implementation Spec: Agent Orchestrator Flows

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Add a `run_from_ideation` tool and enrich the orchestrator system prompt to support two conversation-to-execution flows.

The `run_from_ideation` tool ports the from-ideation SKILL.md execution logic as a Pi ToolDefinition. It handles: loading contracts, discovering specs, creating tasks, branching, running implementer per spec phase, then a single verify → review → close pass for the combined diff. The core logic lives in a separate module (`src/agent/from-ideation.ts`) so the tool is a thin wrapper.

The system prompt is the main lever for the quick flow. When the user says "go," the agent uses its judgment to: (a) decide scope (spec-only vs contract+spec), (b) write artifacts to `docs/ideation/{slug}/`, and (c) invoke `run_from_ideation`. No new tool is needed for the quick flow — the agent uses Pi's built-in write tool for artifacts and then calls `run_from_ideation`.

## Feedback Strategy

**Inner-loop command**: `bun run typecheck && bun test`

**Playground**: Test suite — the from-ideation module and tool are pure logic with clear I/O boundaries.

**Why this approach**: The module is all async functions calling existing infrastructure. Tests mock the I/O boundaries (spawnAgent, runScript, filesystem).

## File Changes

### New Files

| File Path                               | Purpose                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/agent/from-ideation.ts`            | Core from-ideation execution logic: load contract, create task, execute phases, post-impl pipeline |
| `src/agent/tools/from-ideation-tool.ts` | Pi ToolDefinition wrapper around the from-ideation module                                          |
| `src/__tests__/from-ideation.spec.ts`   | Tests for contract loading, phase discovery, task creation, execution flow                         |

### Modified Files

| File Path                           | Changes                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| `src/agent/orchestrator-session.ts` | Register from-ideation tool, enrich system prompt with both flows |
| `src/types.ts`                      | Add `FromIdeationOptions` and `PhaseResult` interfaces            |

## Implementation Details

### 1. Types (`src/types.ts`)

**Overview**: Add interfaces for the from-ideation module.

```typescript
export interface FromIdeationOptions {
  ideationFolder: string;
  caseRoot: string;
  repoName: string;
  repoPath: string;
  /** Called with progress updates during execution */
  onProgress?: (message: string) => void;
}

export interface PhaseResult {
  phase: number;
  specFile: string;
  status: 'completed' | 'failed' | 'skipped';
  commit: string | null;
  summary: string;
  error: string | null;
}
```

**Implementation steps**:

1. Add both interfaces to `src/types.ts` after the existing `SpawnAgentResult` block

### 2. From-Ideation Module (`src/agent/from-ideation.ts`)

**Pattern to follow**: `src/entry/cli-orchestrator.ts` (deterministic step-by-step flow) and `skills/from-ideation/SKILL.md` (the logic being ported)

**Overview**: Core execution logic for running ideation contracts through the pipeline. Orchestrates: contract loading → task creation → branch setup → per-phase implementer spawning → validation → verify → review → close.

```typescript
import { resolve } from 'node:path';
import { spawnAgent } from './pi-runner.js';
import { createTask } from '../entry/task-factory.js';
import { runScript } from '../util/run-script.js';
import { parseAgentResult } from '../util/parse-agent-result.js';
import { loadSystemPrompt } from './prompt-loader.js';
import type { FromIdeationOptions, PhaseResult, AgentResult, TaskCreateRequest } from '../types.js';

interface ContractInfo {
  problemStatement: string;
  goals: string;
  successCriteria: string;
  specFiles: string[];  // sorted by phase number
}

export async function loadContract(ideationFolder: string): Promise<ContractInfo> { ... }
export async function discoverSpecs(ideationFolder: string): Promise<string[]> { ... }
export async function executeFromIdeation(options: FromIdeationOptions): Promise<{
  success: boolean;
  phases: PhaseResult[];
  prUrl: string | null;
  error: string | null;
}> { ... }
```

**Key decisions**:

- The module returns structured results, not void — the tool can relay progress to the orchestrator
- `onProgress` callback streams updates during long-running execution
- Each phase spawns the implementer via `spawnAgent()` (same as pipeline phases)
- Post-implementation uses `spawnAgent()` for verifier, reviewer, closer — same as existing pipeline
- Re-entry: check for existing task by `contractPath` match before creating new one
- Branch: `feat/{project-name}` derived from ideation folder name

**Implementation steps**:

1. `loadContract()`: read contract.md, extract problem/goals/criteria sections via regex
2. `discoverSpecs()`: glob for `spec.md`, `spec-phase-*.md`, sort by phase number
3. `executeFromIdeation()` main flow:
   a. Load contract and discover specs
   b. Check for existing task (re-entry via contractPath match in tasks/active/)
   c. If no existing task: create task files, checkout branch, run baseline
   d. For each spec: read spec + template (if referenced), spawn implementer with spec context
   e. After all phases: run validation (test command from projects.json + mark-tested.sh)
   f. Spawn verifier, reviewer, closer sequentially
   g. Return structured result with PR URL

**Feedback loop**:

- **Playground**: Create test file with mock filesystem and spawnAgent
- **Check command**: `bun test src/__tests__/from-ideation.spec.ts`

### 3. From-Ideation Tool (`src/agent/tools/from-ideation-tool.ts`)

**Pattern to follow**: `src/agent/tools/pipeline-tool.ts` (ToolDefinition wrapper pattern)

**Overview**: Thin Pi ToolDefinition that exposes `executeFromIdeation` to the orchestrator agent.

```typescript
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { executeFromIdeation } from '../from-ideation.js';
import { detectRepo } from '../../entry/repo-detector.js';

const fromIdeationParams = Type.Object({
  ideationFolder: Type.String({ description: 'Path to ideation folder containing contract.md and spec files' }),
  phase: Type.Optional(Type.Number({ description: 'Specific phase to execute (default: all)' })),
});

export function createFromIdeationTool(caseRoot: string): ToolDefinition<typeof fromIdeationParams> {
  return {
    name: 'run_from_ideation',
    label: 'From Ideation',
    description: 'Execute an ideation contract through the case pipeline — all phases on one branch, one PR',
    promptSnippet: 'Execute ideation specs through the pipeline',
    parameters: fromIdeationParams,
    execute: async (_toolCallId, params, _signal, onUpdate, _ctx) => {
      const detected = await detectRepo(caseRoot);

      const result = await executeFromIdeation({
        ideationFolder: params.ideationFolder,
        caseRoot,
        repoName: detected.name,
        repoPath: detected.path,
        onProgress: (message) => {
          onUpdate?.({
            content: [{ type: 'text', text: message }],
            details: { ideationFolder: params.ideationFolder },
          });
        },
      });

      const summary = result.success
        ? `Pipeline completed. PR: ${result.prUrl}\n\nPhases:\n${result.phases.map((p) => `  Phase ${p.phase}: ${p.status} — ${p.summary}`).join('\n')}`
        : `Pipeline failed: ${result.error}\n\nPhases:\n${result.phases.map((p) => `  Phase ${p.phase}: ${p.status}`).join('\n')}`;

      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
    },
  };
}
```

**Key decisions**:

- Takes `ideationFolder` path, not individual spec files — the module handles discovery
- Optional `phase` param for "execute just phase 2" — useful for incremental execution after ideation
- Progress streaming via `onUpdate` so the orchestrator sees what's happening
- Returns full structured result so the agent can report intelligently

**Implementation steps**:

1. Create the ToolDefinition with TypeBox params
2. Detect repo from caseRoot in execute
3. Call executeFromIdeation with progress callback
4. Format result summary for the agent

### 4. System Prompt Enrichment (`src/agent/orchestrator-session.ts`)

**Overview**: Update `buildOrchestratorSystemPrompt()` to describe both flows and guide agent decision-making.

The system prompt should cover:

- **Quick flow**: When the user says "go" / "build this" / "let's do it" → agent judges scope, writes spec (or contract+spec for larger work) to `docs/ideation/{slug}/`, then calls `run_from_ideation`
- **Ideation flow**: When the user wants to plan → agent brainstorms, asks questions, writes artifacts incrementally, presents for approval, then executes
- **Pre-existing artifacts**: When user says "execute docs/ideation/foo/" → agent calls `run_from_ideation` directly
- **Heuristic for spec-only vs contract+spec**: Small focused fix touching 1-3 files → spec only. Multi-concern work, multiple phases, or architectural changes → contract + specs.

**Key decisions**:

- Keep system prompt under 1500 tokens total (Pi base ~200, we add ~1300 of case context)
- Be directive, not suggestive — "When the user says go, do X" not "you might consider X"
- Reference file paths for the agent to read on demand, don't inline large docs

**Implementation steps**:

1. Rewrite `buildOrchestratorSystemPrompt()` with expanded guidance
2. Register `createFromIdeationTool` in the customTools array

### 5. Tool Registration (`src/agent/orchestrator-session.ts`)

**Overview**: Add the from-ideation tool to the session's customTools.

```typescript
import { createFromIdeationTool } from './tools/from-ideation-tool.js';

// In startOrchestratorSession:
customTools: [
  createPipelineTool(options.caseRoot),
  createFromIdeationTool(options.caseRoot),
  createIssueTool(options.caseRoot),
  createTaskTool(options.caseRoot),
  createBaselineTool(options.caseRoot),
],
```

## Testing Requirements

### Unit Tests

| Test File                             | Coverage                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `src/__tests__/from-ideation.spec.ts` | Contract loading, spec discovery, execution flow, re-entry, error handling |

**Key test cases**:

- `loadContract()` extracts problem/goals/criteria from markdown
- `discoverSpecs()` finds and sorts spec files correctly
- `discoverSpecs()` handles single spec (no phase number)
- `executeFromIdeation()` creates task, spawns implementer per phase, then verifier/reviewer/closer
- Re-entry: finds existing task by contractPath, skips completed phases
- Error: implementer failure returns structured error, doesn't crash
- Progress callback fires for each phase transition
- From-ideation tool registers with correct name and params

### Manual Testing

- [ ] `xcase --agent` → discuss a fix → "go" → agent writes spec → pipeline runs
- [ ] `xcase --agent` → "execute docs/ideation/pi-agent-migration/" → tool picks up existing artifacts
- [ ] Interrupt mid-execution, re-run → resumes from correct phase

## Error Handling

| Error Scenario                 | Handling Strategy                                                  |
| ------------------------------ | ------------------------------------------------------------------ |
| Contract not found in folder   | Return error: "No contract.md found in {path}"                     |
| No spec files found            | Return error: "No spec files found in {path}"                      |
| Implementer fails for a phase  | Record failure in PhaseResult, return overall failure with details |
| Baseline fails                 | Return error with baseline output                                  |
| Repo not detected              | Return error: "Not in a recognized target repo"                    |
| Verifier/reviewer/closer fails | Return failure with the failed agent's result                      |

## Validation Commands

```bash
bun run typecheck
bun test
pnpm lint
```

## Open Items

- [ ] Should the agent stream the implementer's output in real-time, or just report phase completion? (Pi's tool update mechanism may limit this)
- [ ] How much of the from-ideation re-entry logic is needed initially? Could start with fresh-only and add re-entry in a follow-up.
