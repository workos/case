# Implementation Spec: Orchestrator Refinement - Phase 1

**Contract**: ./contract.md
**Estimated Effort**: S

## Technical Approach

Update `improvements.md` to reclassify Wave 5 items (HTTP server, webhooks, scanners) from completed to deferred. Keep Wave 4 items (pipeline, metrics, context assembly) as completed. Add a rationale section explaining why: the orchestrator core is justified by determinism/correctness arguments, but the service layer solves problems at a scale Case doesn't operate at yet.

Also note the SDK-path mistake in the completed items — agent-runner.ts should use CLI only.

## Feedback Strategy

**Inner-loop command**: `head -150 improvements.md` (verify structure looks right)

**Playground**: None — documentation-only change.

**Why this approach**: Single file edit, visual inspection is sufficient.

## File Changes

### Modified Files

| File Path          | Changes                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `improvements.md`  | Move items #20, #40 (phases 4-5), #50 out of completed table. Reclassify in deferred. Add rationale section. |

## Implementation Details

### Reclassify Wave 5 items

**Overview**: Three items currently in the completed table belong in deferred because they represent premature service-layer infrastructure.

**Items to move from Completed to Deferred:**

| # | Item | Current "How it shipped" | New deferred note |
|---|------|--------------------------|-------------------|
| **20** | Multiple entry points | `src/server.ts` HTTP service... | Code exists but premature; activate when task volume justifies a running service |
| **50** | Proactive work finding | `src/entry/scanners/`... | Code exists but premature; activate when manual task identification becomes a bottleneck |

**Item to split:**

| # | Item | Action |
|---|------|--------|
| **40** | Hybrid orchestration | Keep phases 1-3 (pipeline.ts, phase modules, context assembly) as completed. Move phases 4-5 (metrics service, prompt version service) description to note that metrics collection code exists but the service layer wrapping it is premature. |

Actually, looking more carefully: item #40's "phases 4-5" row in the completed table describes `src/metrics/` and `src/versioning/prompt-tracker.ts` — these are libraries, not the service layer. They're used by the pipeline itself. The service layer is #20 (server.ts) and #50 (scanners). So #40 stays completed as-is.

**Steps:**

1. Remove items #20 and #50 from the completed table
2. Add #20 and #50 to the deferred table with notes that code exists but is premature
3. Add a new section after the completed/deferred tables: "### Architecture Note: Orchestrator Core vs Service Layer"
4. In that section, explain:
   - The pipeline loop, phase modules, metrics collection, and context assembly (Wave 4) are justified by determinism/correctness at any scale
   - The HTTP server, webhooks, and scanners (Wave 5) solve problems at Stripe-scale that Case doesn't have yet
   - The SDK spawning path in agent-runner.ts was a mistake — it bypasses the harness enforcement layer
   - The code is left in place but the items are deferred until scale justifies activation
5. Update the revision note at the top to reflect the change
6. Update the count: previously "41 completed, 19 deferred" — now "39 completed, 21 deferred"

## Validation Commands

```bash
# Verify markdown renders correctly (visual check)
head -80 improvements.md

# Verify item counts
grep -c '^\| \*\*' improvements.md
```

## Error Handling

| Error Scenario | Handling Strategy |
|---|---|
| Accidentally remove wrong item | Git diff review before commit |

## Testing Requirements

### Manual Testing

- [ ] All 60 items are still accounted for (39 completed + 21 deferred = 60)
- [ ] No item appears in both completed and deferred
- [ ] Rationale section clearly explains the distinction
- [ ] Revision note at top is updated
