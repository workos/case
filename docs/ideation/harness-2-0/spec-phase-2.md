# Implementation Spec: Harness 2.0 - Phase 2 (Binary Rubric Categories)

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Replace prose-based evaluation with structured binary rubrics for both the verifier and reviewer. Each rubric has 4 categories with pass/fail/na verdicts. The rubric output goes into AGENT_RESULT as structured JSON. The pipeline reads rubric verdicts to gate PR creation instead of relying solely on the `findings.critical` count.

Two rubric types:
- **Verifier rubric**: behavioral truth (did the fix actually work?)
- **Reviewer rubric**: architectural truth (does the change meet principles?)

The rubric structure is shared (same TypeScript types), but categories differ per role. This phase modifies types, both agent prompts, and the review phase gate logic.

## Feedback Strategy

**Inner-loop command**: `bun test`
**Playground**: Test suite + manual agent output inspection.
**Why this approach**: Type changes and prompt changes can be validated by type checking and unit tests on the review phase gate logic.

## File Changes

### New Files

_None_

### Modified Files

| File Path | Changes |
|---|---|
| `src/types.ts` | Add `RubricVerdict`, `RubricCategory`, `VerifierRubric`, `ReviewerRubric` types; extend `AgentResult` with optional `rubric` field |
| `agents/verifier.md` | Update Output section to include rubric JSON in AGENT_RESULT |
| `agents/reviewer.md` | Update Output section to include rubric JSON in AGENT_RESULT; update findings classification to align with rubric |
| `src/phases/review.ts` | Check rubric verdicts in addition to critical count for gate logic |
| `src/phases/verify.ts` | Extract rubric from verifier result for downstream use |

## Implementation Details

### 1. Rubric Types

**Pattern to follow**: Existing `ReviewFindings` type in `src/types.ts`

**Overview**: Define shared rubric structure and role-specific category sets.

```typescript
export type RubricVerdict = 'pass' | 'fail' | 'na';

export interface RubricCategory {
  /** Category name (e.g., "reproduced-scenario") */
  category: string;
  /** Binary verdict */
  verdict: RubricVerdict;
  /** Finding text when verdict is fail; brief note when pass/na */
  detail: string;
}

/**
 * Verifier rubric — behavioral truth.
 * Categories: reproduced-scenario, exercised-changed-path, evidence-proves-change, edge-case-checked
 */
export interface VerifierRubric {
  role: 'verifier';
  categories: RubricCategory[];
}

/**
 * Reviewer rubric — architectural truth.
 * Categories: principle-compliance, test-sufficiency, scope-discipline, pattern-fit
 */
export interface ReviewerRubric {
  role: 'reviewer';
  categories: RubricCategory[];
}

export type Rubric = VerifierRubric | ReviewerRubric;
```

Add to `AgentResult`:

```typescript
export interface AgentResult {
  // ... existing fields ...
  /** Structured rubric from evaluator agents (verifier/reviewer) */
  rubric?: Rubric;
}
```

**Key decisions**:
- `RubricCategory` is a flat array, not a record keyed by name — allows the agent to output categories in any order and makes parsing more resilient.
- `na` verdict for cases where a category doesn't apply (e.g., edge-case-checked when the fix is a typo). This is explicitly NOT a skip — the agent must justify why it's NA.
- Rubric is optional on AgentResult — non-evaluator agents (implementer, closer) never set it.

### 2. Verifier Prompt Update

**Pattern to follow**: Existing AGENT_RESULT block in `agents/verifier.md` step 6

**Overview**: Add rubric output instructions to the verifier's Output section. The verifier fills in four categories after completing verification.

Add before the existing AGENT_RESULT block in step 6:

```markdown
### 5b. Score Rubric

After testing, score each category honestly. `fail` means the evidence doesn't support this claim. `na` means the category genuinely doesn't apply (justify why in detail).

| Category | Question | When to mark NA |
|---|---|---|
| `reproduced-scenario` | Did you reproduce the exact scenario from the issue? | Issue is a refactor with no user-visible behavior change |
| `exercised-changed-path` | Did your test exercise the new/modified code path specifically? | Only config/docs changed (no src/ changes) |
| `evidence-proves-change` | Would reverting the commit make your evidence look different? | No visual or behavioral difference to capture |
| `edge-case-checked` | Did you test at least one edge case beyond the happy path? | Fix is trivially scoped (typo, import path) |
```

Update the AGENT_RESULT template:

```json
{
  "status": "completed",
  "summary": "<one-line>",
  "rubric": {
    "role": "verifier",
    "categories": [
      {"category": "reproduced-scenario", "verdict": "pass|fail|na", "detail": "<what was tested or why NA>"},
      {"category": "exercised-changed-path", "verdict": "pass|fail|na", "detail": "<evidence>"},
      {"category": "evidence-proves-change", "verdict": "pass|fail|na", "detail": "<before/after comparison>"},
      {"category": "edge-case-checked", "verdict": "pass|fail|na", "detail": "<what edge case was tested>"}
    ]
  },
  "artifacts": { ... },
  "error": null
}
```

**Key decisions**:
- The rubric is IN ADDITION TO existing fields — `artifacts`, `screenshotUrls`, etc. remain unchanged. No breaking changes.
- `detail` is required for all verdicts including `pass` — this forces the agent to state what it actually tested, preventing empty "pass" claims.

### 3. Reviewer Prompt Update

**Pattern to follow**: Existing AGENT_RESULT block in `agents/reviewer.md` step 5

**Overview**: Add rubric output to the reviewer. The reviewer already classifies findings as critical/warning/info — the rubric adds structured categories on top.

Add before the existing AGENT_RESULT block in step 5:

```markdown
### 4b. Score Rubric

After reviewing, score each category. A `fail` on a hard category (principle-compliance, scope-discipline) is critical. A `fail` on a soft category (test-sufficiency, pattern-fit) is a warning.

| Category | Question | Hard/Soft |
|---|---|---|
| `principle-compliance` | Does the diff violate any enforced golden principle (1-7, 14-16, 18)? | Hard — any fail is critical |
| `test-sufficiency` | Did the implementer add/modify tests for changed src/ files? | Soft — fail is a warning |
| `scope-discipline` | Is the change minimal? No unrelated churn, no scope creep? | Hard — excessive scope is critical |
| `pattern-fit` | Does the change follow existing repo patterns and conventions? | Soft — fail is a warning |
```

Update the AGENT_RESULT template:

```json
{
  "status": "completed",
  "summary": "<one-line>",
  "rubric": {
    "role": "reviewer",
    "categories": [
      {"category": "principle-compliance", "verdict": "pass|fail", "detail": "<which principles checked, any violations>"},
      {"category": "test-sufficiency", "verdict": "pass|fail|na", "detail": "<test coverage assessment>"},
      {"category": "scope-discipline", "verdict": "pass|fail", "detail": "<scope assessment>"},
      {"category": "pattern-fit", "verdict": "pass|fail|na", "detail": "<pattern assessment>"}
    ]
  },
  "findings": { ... },
  "artifacts": { ... },
  "error": null
}
```

**Key decisions**:
- `findings` remains the source of truth for individual file-level issues. The rubric is a summary layer — it tells the pipeline whether to proceed; findings tell the implementer what to fix.
- Hard/soft distinction: hard category fails are always critical. Soft category fails are warnings. This replaces the current heuristic where the reviewer must classify each finding manually.
- `principle-compliance` and `scope-discipline` don't support `na` — these always apply.

### 4. Review Phase Gate Logic

**Pattern to follow**: Existing critical findings check in `src/phases/review.ts:69`

**Overview**: Update the review phase to check rubric verdicts in addition to critical count. If the rubric has any hard-category fails, treat as abort even if the reviewer didn't explicitly set `status: "blocked"`.

```typescript
// In src/phases/review.ts — after getting result
const hasRubricBlock = result.rubric?.role === 'reviewer';

if (hasRubricBlock) {
  // Hard categories: fail = critical
  const hardFails = result.rubric.categories.filter(
    (c) => (c.category === 'principle-compliance' || c.category === 'scope-discipline') && c.verdict === 'fail',
  );
  if (hardFails.length > 0) {
    log.phase('review', 'rubric-hard-fail', { categories: hardFails.map((c) => c.category) });
    return { result, nextPhase: 'abort' };
  }
}

// Fallback: existing critical findings check (backward compatible)
if (result.findings && result.findings.critical > 0) {
  log.phase('review', 'critical-findings', { critical: result.findings.critical });
  return { result, nextPhase: 'abort' };
}
```

**Key decisions**:
- Rubric check runs first, findings check is fallback — this means older runs without rubric still work.
- Only hard-category fails trigger abort. Soft-category fails are tracked in metrics (Phase 5) but don't block.
- The verifier rubric doesn't gate anything yet — it's informational for Phase 3 (revision loop).

### 5. Verify Phase — Extract Rubric

**Pattern to follow**: Existing `previousResults.set()` in `src/phases/verify.ts`

**Overview**: No gate logic change for verify phase. The rubric is stored in the AgentResult and passed forward. Phase 3 (revision loop) will use it to determine whether to loop.

No code changes needed in verify.ts for this phase — the existing `previousResults.set('verifier', result)` already carries the rubric. Just document that the rubric is available for downstream phases.

## Testing Requirements

### Unit Tests

| Test File | Coverage |
|---|---|
| `src/phases/review.test.ts` | Review gate logic with rubric verdicts |

**Key test cases**:
- Reviewer result with all rubric categories passing → proceed to close
- Reviewer result with hard-category fail (principle-compliance) → abort
- Reviewer result with soft-category fail only → proceed to close (warning)
- Reviewer result with no rubric (backward compat) → fall through to findings check
- Reviewer result with both rubric hard-fail AND findings.critical > 0 → abort (rubric check fires first)
- Reviewer result with rubric all-pass but findings.critical > 0 → abort (fallback fires)

## Validation Commands

```bash
# Type checking
bun run typecheck

# Unit tests
bun test

# Build
bun run build
```
