# Implementation Spec: Approval Gate - Phase 3: Feedback Flows + Metrics

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 3 completes the approval gate by wiring up the two "Request Changes" flows and integrating approval decisions into the metrics system. The two flows are:

1. **Text feedback** — Human writes feedback in the UI textarea. This becomes a `RevisionRequest` with `source: 'human'` and re-enters the pipeline at implement → verify → review → approve. The implementer receives the human's feedback as structured revision context, just like it would from the verifier or reviewer.

2. **Manual edit** — Human toggles "I'll edit manually" in the UI. The pipeline pauses and waits for a signal (via a second POST to the approval server). The human edits files directly in their editor, then signals ready. The pipeline re-enters at verify → review → approve (skipping implement since the human *is* the implementer).

Both flows eventually loop back to the approval gate, so the human can review the result of their feedback and approve or iterate again.

Metrics integration tracks approval decisions, time spent in the gate, and human revision cycles as first-class pipeline metrics.

## Feedback Strategy

**Inner-loop command**: `bun test src/__tests__/approve-phase.spec.ts src/__tests__/pipeline.spec.ts src/__tests__/metrics-collector.spec.ts`

**Playground**: Test suite + manual integration test with `--approve --dry-run` to verify the full loop.

**Why this approach**: The feedback flows are pipeline-level behavior. Tests verify the state transitions and metric recording. Manual integration confirms the UX.

## File Changes

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/phases/approve.ts` | Implement text feedback → RevisionRequest flow, manual edit → wait-and-re-verify flow |
| `src/phases/approve-server.ts` | Add `/api/ready` endpoint for manual edit signal, keep server alive during manual edit mode |
| `src/phases/approve-ui.ts` | Add manual edit toggle UI, waiting state, ready button for manual edit mode |
| `src/pipeline.ts` | Handle `nextPhase: 'verify'` from approve phase (manual edit re-entry), track approval metrics |
| `src/context/assembler.ts` | Handle `source: 'human'` in `buildRevisionContext` — format human feedback differently than agent rubric failures |
| `src/metrics/collector.ts` | Add approval metrics: decision type, time-in-gate, human revision cycles |
| `src/types.ts` | Add approval metrics fields to `RunMetrics` |
| `src/metrics/writer.ts` | Serialize new approval metrics fields |
| `src/__tests__/approve-phase.spec.ts` | Add tests for text feedback and manual edit flows |
| `src/__tests__/pipeline.spec.ts` | Add tests for approve → verify re-entry (manual edit) and approve → implement (text feedback) with revision cycling |
| `src/__tests__/metrics-collector.spec.ts` | Add tests for approval metrics tracking |

## Implementation Details

### Text Feedback Flow

**Pattern to follow**: `src/phases/revision.ts` `buildRevisionRequest` — creates structured revision context from evaluator findings.

**Overview**: When the human selects "Request Changes" and enters text feedback, this becomes a `RevisionRequest` that the implementer receives as structured context on re-entry.

**Key decisions**:
- `source: 'human'` distinguishes from agent feedback in the implementer's context
- `failedCategories` is empty for human feedback — the human's text IS the feedback, not a rubric
- `suggestedFocus` can optionally be extracted from the human's text if they mention file paths, but v1 keeps it simple: empty array
- The pipeline increments `revisionCycles` and checks against `maxRevisionCycles` same as agent revisions

**Implementation steps**:

1. In `approve.ts`, when decision is `revise` with feedback text:
   ```typescript
   const revision: RevisionRequest = {
     source: 'human',
     failedCategories: [],
     summary: decision.feedback,
     suggestedFocus: [],
     cycle: 0, // pipeline will set this
   };
   return { result: synthResult, nextPhase: 'implement', revision };
   ```
2. In `src/context/assembler.ts` `buildRevisionContext`, add a branch for `source === 'human'`:
   - Header: "## Human Feedback (Approval Gate)"
   - Body: the human's feedback text verbatim
   - Instruction: "Address the feedback above. Make targeted changes only."
   - No rubric category table (unlike verifier/reviewer revisions)
3. Pipeline handles this identically to agent revision: increment cycle, store pending, re-enter implement

**Feedback loop**:
- **Playground**: `src/__tests__/approve-phase.spec.ts`
- **Experiment**: Submit text feedback, verify RevisionRequest is built correctly with `source: 'human'`. Verify pipeline re-enters implement
- **Check command**: `bun test src/__tests__/approve-phase.spec.ts`

### Manual Edit Flow

**Overview**: The human wants to edit code directly instead of describing changes. The pipeline pauses while they work, then re-enters at verify (not implement) since the human made the changes.

**Key decisions**:
- The approval server stays alive during manual edit mode — it needs to receive the "ready" signal
- The UI transitions to a "waiting" state: hides action buttons, shows "Edit your files, then click Ready" with a Ready button
- The `/api/ready` POST endpoint signals that manual edits are complete
- Re-entry is at `verify`, not `implement` — the human IS the implementer in this flow
- This means the pipeline needs to handle `approve` → `verify` as a valid transition

**Implementation steps**:

1. In `approve-server.ts`, add `/api/ready` POST endpoint:
   - Only active when the current decision is `revise` with `manualEdit: true`
   - Resolves a second promise that the approve phase awaits
2. In `approve-ui.ts`, add manual edit waiting state:
   - After "Request Changes" with manual edit toggle ON, POST `/api/decide` with `{ decision: 'revise', manualEdit: true }`
   - UI transitions: hide action buttons, show "Editing mode — make your changes, then click Ready"
   - Ready button POSTs to `/api/ready`
3. In `approve.ts`, handle manual edit flow:
   ```typescript
   if (decision.manualEdit) {
     notifier.send('Manual edit mode — make changes in your editor, then click Ready in the browser');
     await waitForReady(server); // blocks until /api/ready is hit
     server.stop();
     return { result: synthResult, nextPhase: 'verify' };
   }
   ```
4. In `pipeline.ts`, handle `nextPhase: 'verify'` from approve phase:
   - Don't set `pendingRevision` (no revision request for manual edits)
   - Walk status from `approving` → `verifying` (add to STATUS_TRANSITIONS)
5. In `src/types.ts`, add `'verifying'` to `approving`'s allowed transitions:
   ```typescript
   approving: ['closing', 'implementing', 'verifying']
   ```

**Feedback loop**:
- **Playground**: Run approval server with mock data, submit manual edit, verify UI transitions to waiting state, click Ready, verify server shuts down
- **Experiment**: Test the full loop: approve → manual edit → wait → ready → verify → review → approve
- **Check command**: `bun test src/__tests__/pipeline.spec.ts`

### Metrics Integration

**Pattern to follow**: `src/metrics/collector.ts` — existing `MetricsCollector` class with `startPhase`, `endPhase`, `addRevisionCycle`, etc.

**Overview**: Track approval-specific metrics as first-class fields in `RunMetrics`.

**Key decisions**:
- New metrics fields on `RunMetrics`:
  - `approvalDecision: 'approved' | 'revised' | 'rejected' | 'skipped' | null`
  - `approvalTimeMs: number | null` (time from gate open to decision)
  - `humanRevisionCycles: number` (revision cycles triggered by human, distinct from agent revision cycles)
- The existing `revisionCycles` counter includes human-triggered cycles; `humanRevisionCycles` is the subset

**Implementation steps**:

1. Add fields to `RunMetrics` in `src/types.ts`:
   ```typescript
   approvalDecision: 'approved' | 'revised' | 'rejected' | 'skipped' | null;
   approvalTimeMs: number | null;
   humanRevisionCycles: number;
   ```
2. Add methods to `MetricsCollector`:
   - `setApprovalDecision(decision, timeMs)` — records the decision and gate duration
   - `addHumanRevisionCycle()` — increments human revision counter
3. Call `metrics.setApprovalDecision()` from the pipeline's `case 'approve'` block after the phase returns
4. Call `metrics.addHumanRevisionCycle()` when approve phase returns `nextPhase: 'implement'`
5. When approve is skipped (no flag or unattended), set `approvalDecision: 'skipped'`
6. Wire into `writeRunMetrics` in `src/metrics/writer.ts` — serialize new fields to the metrics JSON

**Feedback loop**:
- **Playground**: `src/__tests__/metrics-collector.spec.ts`
- **Experiment**: Verify metrics are recorded for: skipped gate, approved, revised (text), revised (manual edit), rejected
- **Check command**: `bun test src/__tests__/metrics-collector.spec.ts`

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `src/__tests__/approve-phase.spec.ts` | Text feedback → RevisionRequest, manual edit → wait → verify re-entry |
| `src/__tests__/pipeline.spec.ts` | Approve → verify transition (manual edit), approve → implement (text feedback), full revision loop back to approve |
| `src/__tests__/metrics-collector.spec.ts` | Approval decision recording, time tracking, human revision cycle counting |

**Key test cases**:

- Text feedback creates RevisionRequest with `source: 'human'` and empty `failedCategories`
- Pipeline re-enters implement after text feedback, then cycles back through verify → review → approve
- Manual edit returns `nextPhase: 'verify'` (not implement)
- Pipeline handles `approving` → `verifying` transition for manual edit flow
- `maxRevisionCycles` applies to human revision cycles too
- Metrics record `approvalDecision` for all five states (approved, revised, rejected, skipped, null)
- Metrics record `approvalTimeMs` as the duration from phase start to decision
- Metrics record `humanRevisionCycles` separately from total `revisionCycles`
- Context assembler formats human feedback differently from agent rubric failures

### Integration Tests

**Key scenarios**:

- Full pipeline with `--approve`: implement → verify → review → approve (approved) → close
- Full pipeline with `--approve` and human revision: ... → approve (revise) → implement → verify → review → approve (approved) → close
- Full pipeline with `--approve` and reject: ... → approve (reject) → retrospective

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Human revision exceeds `maxRevisionCycles` | Same as agent revision: log warning, proceed to close with "revision budget exhausted" message |
| Manual edit: user never clicks Ready | Server stays alive; log reminder every 60s; Ctrl+C triggers reject |
| Manual edit: user's changes break tests | Verify phase catches this; loops back through review → approve for human to see the failure |
| Feedback text is empty | Treat as "no specific feedback" — RevisionRequest summary becomes "Human requested changes (no specific feedback)" |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
|---|---|---|---|---|
| Text feedback flow | Implementer ignores feedback | Vague human feedback | Changes don't address concern | Human reviews again at next approve gate; can provide more specific feedback |
| Manual edit flow | Edits introduce new issues | Human makes a mistake | Verifier/reviewer catch it | Pipeline re-verifies and re-reviews; issues surface at next approve gate |
| Manual edit flow | Server shutdown before ready | Process killed during manual edit | Edits are made but not verified | Edits persist in git working tree; re-run `ca --approve` to re-enter pipeline |
| Metrics | Time-in-gate inflated | User walks away from approval gate | Metrics misleading | Note in metrics docs; consider adding idle detection in future |

## Validation Commands

```bash
# Type checking
bun run typecheck

# Scoped tests
bun test src/__tests__/approve-phase.spec.ts src/__tests__/pipeline.spec.ts src/__tests__/metrics-collector.spec.ts

# Full test suite
bun test
```
