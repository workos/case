# Implementation Spec: Harness 2.0 - Phase 1 (Done Contract Artifact)

**Contract**: ./contract.md
**Estimated Effort**: S

## Technical Approach

Add four new optional sections to task markdown files generated during task creation: Verification Scenarios, Non-Goals, Edge Cases, and Evidence Expectations. These sections form the "done contract" — a lightweight pre-implementation artifact that aligns the implementer and verifier on what "done" means.

The orchestrator (LLM agent) generates the content for these sections based on the issue context. The `create_task` tool passes them through. The `task-factory.ts` renders them into the task .md file. For ideation-sourced tasks with a `contractPath`, these sections are skipped (the ideation contract already defines this).

No new agents, no new files — just extended fields through the existing task creation pipeline.

## Feedback Strategy

**Inner-loop command**: `bun test`
**Playground**: Test suite — task-factory output can be validated by snapshot or string-match tests.
**Why this approach**: Changes are to data flow (types → tool params → markdown rendering), best validated by unit tests.

## File Changes

### New Files

_None_

### Modified Files

| File Path | Changes |
|---|---|
| `src/types.ts` | Add optional done contract fields to `TaskCreateRequest` |
| `src/agent/tools/task-tool.ts` | Add done contract params to tool schema |
| `src/entry/task-factory.ts` | Render done contract sections in `buildTaskMarkdown()` |
| `tasks/README.md` | Document new sections as optional |

## Implementation Details

### 1. Extend TaskCreateRequest

**Pattern to follow**: Existing optional fields in `TaskCreateRequest` (checkCommand, checkBaseline, etc.)

**Overview**: Add four optional string fields for done contract sections.

```typescript
// In src/types.ts — TaskCreateRequest
export interface TaskCreateRequest {
  // ... existing fields ...

  /** Verification scenarios the verifier will test (done contract) */
  verificationScenarios?: string;
  /** What is explicitly NOT in scope (done contract) */
  nonGoals?: string;
  /** Edge cases to consider (done contract) */
  edgeCases?: string;
  /** What evidence proves the fix works (done contract) */
  evidenceExpectations?: string;
}
```

**Key decisions**:
- String fields (not arrays) — the orchestrator writes free-form markdown lists. Parsing bullet points adds complexity with no benefit since they render directly into markdown.
- All optional — existing task creation continues to work. The orchestrator's prompt will instruct it to fill these in, but they're not enforced at the type level.

### 2. Extend create_task Tool Schema

**Pattern to follow**: Existing optional params in `task-tool.ts`

**Overview**: Add the four fields to the Typebox schema so the orchestrator can pass them through.

```typescript
const taskParams = Type.Object({
  // ... existing fields ...
  verificationScenarios: Type.Optional(Type.String({ description: 'Markdown list of scenarios the verifier will test' })),
  nonGoals: Type.Optional(Type.String({ description: 'What is explicitly NOT in scope for this task' })),
  edgeCases: Type.Optional(Type.String({ description: 'Edge cases the implementer should consider' })),
  evidenceExpectations: Type.Optional(Type.String({ description: 'What evidence proves the fix works (screenshots, test output, etc.)' })),
});
```

Pass them through to `TaskCreateRequest` in the `execute` function.

### 3. Render Done Contract in Task Markdown

**Pattern to follow**: Existing section rendering in `buildTaskMarkdown()` (see Issue Reference section pattern)

**Overview**: After the Acceptance Criteria section, render done contract sections if any are provided. Skip for ideation-sourced tasks.

```typescript
function buildTaskMarkdown(
  request: TaskCreateRequest,
  taskJson: TaskJson,
  issueContext?: IssueContext,
): string {
  // ... existing code ...

  lines.push(
    '## Acceptance Criteria',
    '',
    '- [ ] Fix verified by tests',
    '- [ ] No regressions introduced',
    '',
  );

  // Done contract sections (skip for ideation tasks — contract subsumes this)
  if (request.issueType !== 'ideation') {
    if (request.verificationScenarios) {
      lines.push('## Verification Scenarios', '', request.verificationScenarios, '');
    }
    if (request.nonGoals) {
      lines.push('## Non-Goals', '', request.nonGoals, '');
    }
    if (request.edgeCases) {
      lines.push('## Edge Cases', '', request.edgeCases, '');
    }
    if (request.evidenceExpectations) {
      lines.push('## Evidence Expectations', '', request.evidenceExpectations, '');
    }
  }

  // Progress Log always at the end
  // ...
}
```

**Key decisions**:
- Sections only render when content is provided — empty strings are falsy, so missing fields produce no empty sections.
- `issueType !== 'ideation'` gate — ideation tasks already have full contracts with specs; adding done contract sections would be redundant.
- Sections go after Acceptance Criteria, before Progress Log — the verifier reads these top-to-bottom during assessment.

### 4. Update Documentation

**Pattern to follow**: Existing section documentation in `tasks/README.md`

Add the four sections to the "Required Sections" table as optional:

| Section | Purpose |
|---|---|
| `## Verification Scenarios` | (Optional) Concrete scenarios the verifier will test — generated by orchestrator during task creation |
| `## Non-Goals` | (Optional) What is explicitly NOT in scope — prevents implementer scope creep |
| `## Edge Cases` | (Optional) Edge cases the implementer should consider |
| `## Evidence Expectations` | (Optional) What proof of completion looks like (screenshots, test output, etc.) |

## Testing Requirements

### Unit Tests

| Test File | Coverage |
|---|---|
| `src/entry/task-factory.test.ts` | Task markdown rendering with done contract sections |

**Key test cases**:
- Task with all four done contract fields renders all four sections
- Task with no done contract fields renders no extra sections (backward compatibility)
- Task with partial fields (e.g., only verificationScenarios) renders only those sections
- Ideation task with done contract fields skips them (issueType === 'ideation')
- Sections appear after Acceptance Criteria and before Progress Log

## Validation Commands

```bash
# Type checking
bun run typecheck

# Unit tests
bun test

# Build
bun run build
```
