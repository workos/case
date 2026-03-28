# Implementation Spec: Harness 2.0 - Phase 5 (Expanded Run Metrics)

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Expand the metrics system to track harness-effectiveness data that enables ablation analysis. The current `RunMetrics` tracks phase timings, CI first-push, review findings, and prompt versions. This phase adds: task profile, revision loop counts, human override tracking, and evaluator effectiveness signals.

The goal is answering: "Is this harness component still load-bearing?" Data collected here feeds the retrospective's analysis and enables periodic harness audits.

## Feedback Strategy

**Inner-loop command**: `bun test`
**Playground**: Test suite — metrics are pure data collection, testable by unit tests.
**Why this approach**: MetricsCollector is a stateful class with simple set/increment methods. Tests verify correct accumulation.

## File Changes

### New Files

_None_

### Modified Files

| File Path | Changes |
|---|---|
| `src/types.ts` | Add new fields to `RunMetrics`, add `HarnessEffectiveness` type |
| `src/metrics/collector.ts` | Add collection methods for new metrics |
| `src/pipeline.ts` | Call new collection methods at decision points |
| `agents/retrospective.md` | Add revision loop analysis as a new signal type |

## Implementation Details

### 1. Extended RunMetrics Type

**Pattern to follow**: Existing `RunMetrics` in `src/types.ts`

```typescript
export interface RunMetrics {
  // ... existing fields (unchanged) ...
  runId: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  outcome: 'completed' | 'failed';
  failedAgent?: AgentName;
  phases: PhaseMetrics[];
  ciFirstPush: boolean | null;
  reviewFindings: ReviewFindings | null;
  promptVersions: Record<string, string>;

  // --- New fields ---

  /** Pipeline profile used for this run */
  profile: PipelineProfile;

  /** Number of evaluator→implementer revision cycles */
  revisionCycles: number;

  /** Number of times a human overrode an evaluator decision (attended mode) */
  humanOverrides: number;

  /** Evaluator effectiveness signals */
  evaluatorEffectiveness: EvaluatorEffectiveness;
}

export interface EvaluatorEffectiveness {
  /** Verifier rubric results (if verifier ran) */
  verifierRubric: RubricCategory[] | null;

  /** Reviewer rubric results (if reviewer ran) */
  reviewerRubric: RubricCategory[] | null;

  /** Did a revision cycle fix the evaluator's findings? (null if no revision) */
  revisionFixedIssues: boolean | null;

  /** Phases that were skipped due to profile */
  skippedPhases: PipelinePhase[];
}
```

**Key decisions**:
- `verifierRubric` and `reviewerRubric` store the final rubric from each evaluator. This allows post-hoc analysis: "what categories fail most often?", "which repos have the most scope-discipline issues?"
- `revisionFixedIssues` is `true` if a revision cycle ran AND the subsequent verify/review passed. `false` if the revision didn't fix the issues. `null` if no revision occurred. This directly answers "are revision loops worth the cost?"
- `humanOverrides` counts attended-mode overrides (e.g., "Override and continue" on review failure). High override counts suggest the evaluator is too strict.
- `skippedPhases` tracks which phases the profile skipped. Enables: "tasks that skipped verify — did they have follow-up defects?"

### 2. MetricsCollector Extensions

**Pattern to follow**: Existing `setCiFirstPush()`, `setReviewFindings()` methods

```typescript
export class MetricsCollector {
  // ... existing fields ...
  private profile: PipelineProfile = 'standard';
  private _revisionCycles = 0;
  private humanOverrides = 0;
  private verifierRubric: RubricCategory[] | null = null;
  private reviewerRubric: RubricCategory[] | null = null;
  private revisionFixedIssues: boolean | null = null;
  private skippedPhases: PipelinePhase[] = [];

  /** Set the pipeline profile for this run. */
  setProfile(profile: PipelineProfile): void {
    this.profile = profile;
  }

  /** Increment revision cycle counter. */
  addRevisionCycle(): void {
    this._revisionCycles++;
  }

  /** Record that a human overrode an evaluator decision. */
  addHumanOverride(): void {
    this.humanOverrides++;
  }

  /** Record verifier rubric results. */
  setVerifierRubric(rubric: RubricCategory[]): void {
    this.verifierRubric = rubric;
  }

  /** Record reviewer rubric results. */
  setReviewerRubric(rubric: RubricCategory[]): void {
    this.reviewerRubric = rubric;
  }

  /** Record whether a revision cycle resolved the evaluator's findings. */
  setRevisionFixedIssues(fixed: boolean): void {
    this.revisionFixedIssues = fixed;
  }

  /** Record a phase skipped by profile. */
  addSkippedPhase(phase: PipelinePhase): void {
    this.skippedPhases.push(phase);
  }

  finalize(outcome: 'completed' | 'failed', failedAgent?: AgentName): RunMetrics {
    const completedAt = new Date().toISOString();

    return {
      // ... existing fields ...
      profile: this.profile,
      revisionCycles: this._revisionCycles,
      humanOverrides: this.humanOverrides,
      evaluatorEffectiveness: {
        verifierRubric: this.verifierRubric,
        reviewerRubric: this.reviewerRubric,
        revisionFixedIssues: this.revisionFixedIssues,
        skippedPhases: this.skippedPhases,
      },
    };
  }
}
```

### 3. Pipeline Integration Points

**Pattern to follow**: Existing `metrics.setCiFirstPush()` calls in `src/pipeline.ts`

Add metric collection calls at each decision point:

```typescript
// At pipeline start
metrics.setProfile(task.profile ?? 'standard');

// When a phase is skipped by profile
metrics.addSkippedPhase(skipped);

// In verify case — after revision request
metrics.addRevisionCycle();

// In verify case — after clean pass on re-verify (revision worked)
if (revisionCycles > 0 && !output.revision) {
  metrics.setRevisionFixedIssues(true);
}

// In verify case — budget exhausted (revision didn't fully fix)
if (output.revision && revisionCycles >= config.maxRevisionCycles) {
  metrics.setRevisionFixedIssues(false);
}

// In review case — capture rubric
if (output.result.rubric?.role === 'reviewer') {
  metrics.setReviewerRubric(output.result.rubric.categories);
}

// In verify case — capture rubric
if (output.result.rubric?.role === 'verifier') {
  metrics.setVerifierRubric(output.result.rubric.categories);
}

// In handleFailure — when user chooses override
if (choice === 'Override and continue') {
  metrics.addHumanOverride();
}
```

### 4. Retrospective — Revision Loop Signal

**Pattern to follow**: Existing signal analysis in `agents/retrospective.md` step 2

Add revision loop as a new signal type in the retrospective's analysis table:

```markdown
| Signal | Root Cause Questions |
|---|---|
| **Revision loops** | What did the evaluator catch? Was the done contract unclear? Was the fix approach wrong? Did revision resolve it? |
```

And in the classification table:

```markdown
| Signal | Fix Location | Example |
|---|---|---|
| Revision loop on same category 3+ times | `agents/implementer.md` | "Add explicit reminder to check edge cases before committing" |
| Revision didn't fix the issue | `agents/verifier.md` or `agents/reviewer.md` | "Evaluator feedback was too vague — make rubric detail more prescriptive" |
| High human override rate | `agents/reviewer.md` | "Reviewer is too strict on pattern-fit for this repo type" |
```

The retrospective already reads the task .task.json and run-log.jsonl. The new metrics fields are automatically available to it.

## Testing Requirements

### Unit Tests

| Test File | Coverage |
|---|---|
| `src/metrics/collector.test.ts` | All new collection methods and finalize output |

**Key test cases**:
- `setProfile` → appears in finalized metrics
- `addRevisionCycle` increments counter
- `addHumanOverride` increments counter
- `setVerifierRubric` / `setReviewerRubric` stored correctly
- `setRevisionFixedIssues(true)` and `false` both stored
- `addSkippedPhase` accumulates phases
- Default values: revisionCycles=0, humanOverrides=0, rubrics=null, skippedPhases=[]
- `finalize()` includes all new fields in output

## Validation Commands

```bash
# Type checking
bun run typecheck

# Unit tests
bun test

# Build
bun run build
```
