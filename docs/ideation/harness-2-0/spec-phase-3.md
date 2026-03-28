# Implementation Spec: Harness 2.0 - Phase 3 (Structured Revision Loop)

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Make the pipeline iterate when evaluators find fixable issues, instead of aborting. When the verifier or reviewer returns feedback that isn't a critical-structural failure, the pipeline writes a structured "revision request" artifact and routes back to the implementer. The implementer receives the revision context prepended to its prompt and focuses on the specific issues.

This is distinct from the existing retry mechanism:
- **Retry** = implementer *failed* (crashed, tests broken, timeout). Trigger: `result.status === 'failed'`. Uses `analyze-failure.sh`.
- **Revision** = implementer *succeeded* but evaluator found fixable issues. Trigger: evaluator rubric has soft fails or verifier rubric has fails. Uses structured revision request.

The retry mechanism fires *inside* each revision pass — a revision attempt gets the same 1-retry treatment as the initial implementation. Bounded at max 2 verify cycles.

## Feedback Strategy

**Inner-loop command**: `bun test`
**Playground**: Test suite + dry-run pipeline to verify phase transitions.
**Why this approach**: Pipeline logic changes need careful testing of state transitions and boundary conditions.

## File Changes

### New Files

_None_

### Modified Files

| File Path | Changes |
|---|---|
| `src/types.ts` | Add `RevisionRequest` type, `maxRevisionCycles` to `PipelineConfig`, `revisionCycles` to `RunMetrics` |
| `src/pipeline.ts` | Add revision loop logic in verify and review cases |
| `src/context/assembler.ts` | Add revision context assembly for implementer re-entry |
| `src/phases/verify.ts` | Return structured feedback when verifier rubric has fails |
| `src/phases/review.ts` | Return structured feedback when reviewer rubric has soft fails |
| `src/metrics/collector.ts` | Track revision cycle count |

## Implementation Details

### 1. RevisionRequest Type

**Pattern to follow**: Existing `FailureAnalysis` type in `src/types.ts`

```typescript
export interface RevisionRequest {
  /** Which evaluator triggered the revision */
  source: 'verifier' | 'reviewer';
  /** Which rubric categories failed */
  failedCategories: Array<{
    category: string;
    verdict: RubricVerdict;
    detail: string;
  }>;
  /** Human-readable summary of what needs fixing */
  summary: string;
  /** Specific files or areas to focus on */
  suggestedFocus: string[];
  /** Which revision cycle this is (1-indexed) */
  cycle: number;
}
```

Add to `PipelineConfig`:

```typescript
export interface PipelineConfig {
  // ... existing fields ...
  /** Max evaluator→implementer revision cycles (default: 2) */
  maxRevisionCycles: number;
}
```

Add to `RunMetrics`:

```typescript
export interface RunMetrics {
  // ... existing fields ...
  /** Number of revision cycles executed (verify→re-implement or review→re-implement) */
  revisionCycles: number;
}
```

### 2. Pipeline Revision Loop

**Pattern to follow**: Existing `handleFailure()` branching in `src/pipeline.ts`

**Overview**: After verify and review phases, check if the result contains a revision request. If so, and if within the cycle budget, route back to implement with revision context.

The key insight: this is NOT a modification of the existing abort/retry path. It's a NEW path where the evaluator *completed successfully* but found issues.

```typescript
// New state tracked in the pipeline loop
let revisionCycles = 0;
let pendingRevision: RevisionRequest | null = null;

// In the verify case, after checking for abort:
case 'verify': {
  const output = await runVerifyPhase(config, store, previousResults);
  const elapsed = Date.now() - phaseStartMs;

  if (output.nextPhase === 'abort') {
    // ... existing abort handling (human choice in attended, auto-abort in unattended) ...
  } else if (output.revision && revisionCycles < config.maxRevisionCycles) {
    // Evaluator completed but found fixable issues — revision loop
    notifier.phaseEnd(currentPhase, 'verifier', elapsed, 'completed');
    metrics.endPhase('completed');
    pendingRevision = output.revision;
    revisionCycles++;
    metrics.addRevisionCycle();
    notifier.send(`Revision cycle ${revisionCycles}: verifier found fixable issues, re-implementing`);
    log.phase('verify', 'revision-requested', {
      cycle: revisionCycles,
      failedCategories: output.revision.failedCategories.map((c) => c.category),
    });
    currentPhase = 'implement';
  } else if (output.revision && revisionCycles >= config.maxRevisionCycles) {
    // Revision budget exhausted — proceed anyway (soft fails don't block)
    notifier.phaseEnd(currentPhase, 'verifier', elapsed, 'completed');
    metrics.endPhase('completed');
    notifier.send(`Revision budget exhausted (${config.maxRevisionCycles} cycles). Proceeding with warnings.`);
    log.phase('verify', 'revision-budget-exhausted', { cycles: revisionCycles });
    currentPhase = output.nextPhase; // review
  } else {
    // Clean pass
    notifier.phaseEnd(currentPhase, 'verifier', elapsed, 'completed');
    metrics.endPhase('completed');
    currentPhase = output.nextPhase;
  }
  break;
}
```

The review case follows the same pattern, but only for soft-category fails (hard fails still abort):

```typescript
case 'review': {
  const output = await runReviewPhase(config, store, previousResults);
  const elapsed = Date.now() - phaseStartMs;

  if (output.nextPhase === 'abort') {
    // Hard fails — existing abort handling
    // ...
  } else if (output.revision && revisionCycles < config.maxRevisionCycles) {
    // Soft fails — revision loop
    notifier.phaseEnd(currentPhase, 'reviewer', elapsed, 'completed');
    metrics.endPhase('completed');
    pendingRevision = output.revision;
    revisionCycles++;
    metrics.addRevisionCycle();
    notifier.send(`Revision cycle ${revisionCycles}: reviewer found fixable issues, re-implementing`);
    currentPhase = 'implement';
  } else if (output.revision && revisionCycles >= config.maxRevisionCycles) {
    // Budget exhausted — proceed (soft fails are warnings, not blockers)
    notifier.phaseEnd(currentPhase, 'reviewer', elapsed, 'completed');
    metrics.endPhase('completed');
    currentPhase = 'close';
  } else {
    // Clean pass
    // ... existing handling ...
  }
  break;
}
```

In the implement case, check for pending revision:

```typescript
case 'implement': {
  // Pass revision context to implement phase
  const output = await runImplementPhase(config, store, previousResults, pendingRevision);
  pendingRevision = null; // Clear after passing

  // ... existing success/failure handling unchanged ...
}
```

**Key decisions**:
- Revision cycles are tracked globally (not per-evaluator). A verify revision and a review revision both count against the same budget. This prevents runaway loops where verify and review each trigger 2 cycles = 4 total.
- When revision budget exhausted, proceed anyway. Soft fails are warnings, not blockers. The closer includes them in the PR description.
- `pendingRevision` is cleared after passing to implement. If implement succeeds, the pipeline re-runs verify (or review), which may find the issues resolved.
- The revision counter doesn't reset between phases. If verify used 1 cycle, review gets 1 remaining.

### 3. PhaseOutput Extension

**Pattern to follow**: Existing `PhaseOutput` in `src/types.ts`

```typescript
export interface PhaseOutput {
  result: AgentResult;
  nextPhase: PipelinePhase;
  /** Structured revision request when evaluator found fixable issues */
  revision?: RevisionRequest;
}
```

### 4. Verify Phase — Generate Revision Request

**Pattern to follow**: Existing verifier result handling in `src/phases/verify.ts`

After the verifier completes, check its rubric for fails:

```typescript
// After getting result and it's status === 'completed'
if (result.rubric?.role === 'verifier') {
  const fails = result.rubric.categories.filter((c) => c.verdict === 'fail');
  if (fails.length > 0) {
    const revision: RevisionRequest = {
      source: 'verifier',
      failedCategories: fails,
      summary: `Verifier found ${fails.length} issue(s): ${fails.map((f) => f.category).join(', ')}`,
      suggestedFocus: fails.map((f) => f.detail),
      cycle: 0, // Pipeline will set the actual cycle number
    };
    return { result, nextPhase: 'review', revision };
  }
}

// Clean pass
return { result, nextPhase: 'review' };
```

### 5. Review Phase — Generate Revision Request for Soft Fails

**Pattern to follow**: Existing review gate in `src/phases/review.ts`

After the hard-fail check (which still triggers abort), check for soft fails:

```typescript
// After hard-fail abort check passes...

// Check for soft-category fails (test-sufficiency, pattern-fit)
if (result.rubric?.role === 'reviewer') {
  const softFails = result.rubric.categories.filter(
    (c) => (c.category === 'test-sufficiency' || c.category === 'pattern-fit') && c.verdict === 'fail',
  );
  if (softFails.length > 0) {
    const revision: RevisionRequest = {
      source: 'reviewer',
      failedCategories: softFails,
      summary: `Reviewer found ${softFails.length} soft issue(s): ${softFails.map((f) => f.category).join(', ')}`,
      suggestedFocus: softFails.map((f) => f.detail),
      cycle: 0,
    };
    return { result, nextPhase: 'close', revision };
  }
}
```

### 6. Context Assembler — Revision Context

**Pattern to follow**: Existing retry context pattern in `src/phases/implement.ts:106-117`

**Overview**: When the implementer is re-entered via revision loop, prepend structured revision context to its prompt. This is analogous to the RETRY CONTEXT but carries evaluator feedback instead of failure analysis.

Add to `assemblePrompt()`:

```typescript
export async function assemblePrompt(
  role: AgentName,
  config: PipelineConfig,
  task: TaskJson,
  repoContext: RepoContext,
  previousResults: Map<AgentName, AgentResult>,
  revision?: RevisionRequest, // NEW parameter
): Promise<string> {
  const template = await Bun.file(templatePath).text();
  const contextBlock = buildContextBlock(role, config, task, repoContext, previousResults);

  let prompt = `${template}\n\n${contextBlock}`;

  // Prepend revision context for implementer re-entry
  if (role === 'implementer' && revision) {
    prompt = buildRevisionContext(revision) + '\n\n' + prompt;
  }

  return prompt;
}

function buildRevisionContext(revision: RevisionRequest): string {
  const lines = [
    `## REVISION CONTEXT — ${revision.source} found fixable issues (cycle ${revision.cycle})`,
    '',
    `**Source:** ${revision.source}`,
    `**Summary:** ${revision.summary}`,
    '',
    '**Failed categories:**',
    ...revision.failedCategories.map(
      (c) => `- **${c.category}** (${c.verdict}): ${c.detail}`,
    ),
    '',
    '**Suggested focus:**',
    ...revision.suggestedFocus.map((f) => `- ${f}`),
    '',
    'Address these specific issues. Do NOT redo the entire implementation.',
    'Make targeted fixes, re-run validation, and commit.',
    '',
  ];
  return lines.join('\n');
}
```

**Key decisions**:
- Revision context goes at the TOP of the prompt (before the agent template), same as retry context. This ensures it's seen first and survives context compaction.
- The revision context explicitly says "do NOT redo the entire implementation" — prevents the implementer from starting over when only targeted fixes are needed.
- The `revision` parameter is threaded through from pipeline → implement phase → assemblePrompt. It's optional and only set during revision loops.

### 7. Implement Phase — Accept Revision Context

**Pattern to follow**: Existing `runImplementPhase()` signature

Update `runImplementPhase` to accept and thread the revision:

```typescript
export async function runImplementPhase(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
  revision?: RevisionRequest, // NEW parameter
): Promise<PhaseOutput> {
  // ... existing status updates ...

  const repoContext = await prefetchRepoContext(config, 'implementer');
  const prompt = await assemblePrompt('implementer', config, task, repoContext, previousResults, revision);

  // ... rest unchanged — spawn, retry on failure, etc.
}
```

The existing retry mechanism (analyze-failure.sh) fires if the implementer crashes/fails during a revision pass — this is by design. A revision pass gets the same 1-retry treatment as the initial implementation.

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
|---|---|---|---|---|
| Revision loop | Infinite loop | Bug in cycle counter | Pipeline never terminates | Hard cap at `maxRevisionCycles` (default 2) |
| Revision loop | Regression | Implementer fix breaks something else | Verifier catches it next cycle | Bounded cycles prevent infinite regression loops |
| Revision context | Context bloat | Multiple revision cycles accumulate context | Implementer context window fills up | Revision context replaces previous (not appends). Only latest cycle's context is prepended. |
| Revision + retry | Double cost | Revision pass + retry = 2 extra spawns per cycle | High token cost | Budget is explicit (max 4 implementer spawns worst case). Metrics track it. |

## Testing Requirements

### Unit Tests

| Test File | Coverage |
|---|---|
| `src/pipeline.test.ts` | Revision loop state transitions |
| `src/phases/verify.test.ts` | Revision request generation from verifier rubric |
| `src/phases/review.test.ts` | Revision request generation from reviewer soft fails |
| `src/context/assembler.test.ts` | Revision context prepended to implementer prompt |

**Key test cases**:
- Verifier rubric with fails → revision request generated, pipeline routes to implement
- Verifier rubric all-pass → no revision, pipeline proceeds to review
- Review hard-fail → abort (NOT revision)
- Review soft-fail → revision request generated
- Revision cycle counter increments per cycle
- Revision budget exhausted → proceed without revision
- Revision context is prepended to implementer prompt
- Multiple revision cycles don't accumulate context (latest replaces previous)
- Revision pass with implementer failure → retry fires inside the revision
- Pipeline with revision cycles set to 0 → revision disabled, existing behavior

### Integration Test

- Dry-run pipeline with mocked agent results that trigger revision → verify state transitions

## Validation Commands

```bash
# Type checking
bun run typecheck

# Unit tests
bun test

# Build
bun run build
```
