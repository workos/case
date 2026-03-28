# Implementation Spec: Harness 2.0 - Phase 4 (Adaptive Pipeline Profiles)

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Replace the one-size-fits-all pipeline with profile-based phase selection. Three profiles define which phases run:

| Profile | Phases | Use Case |
|---|---|---|
| `tiny` | implement → review → close | Docs, config, typos — no verification needed |
| `standard` | implement → verify → review → close | Bug fixes, small features — current default |
| `complex` | implement → verify → review → close | Multi-file features — same as standard but with done contract required |

All profiles always run retrospective after completion or failure.

The orchestrator sets the `profile` field in `.task.json` during task creation. The pipeline reads it to determine which phases to execute. Default is `standard` for backward compatibility.

Note: `complex` has the same phases as `standard` in this initial version. The difference is that `complex` tasks require done contract sections (enforced by Phase 1's orchestrator prompt). Future work may add a dedicated planning phase for `complex` tasks.

## Feedback Strategy

**Inner-loop command**: `bun test`
**Playground**: Test suite + dry-run pipeline to verify phase skipping.
**Why this approach**: State machine changes need comprehensive testing of all profile × phase combinations.

## File Changes

### New Files

_None_

### Modified Files

| File Path | Changes |
|---|---|
| `src/types.ts` | Add `PipelineProfile` type, `profile` field to `TaskJson` |
| `src/pipeline.ts` | Add `PROFILE_PHASES` map, skip phases not in profile |
| `src/state/transitions.ts` | Respect profile when determining entry phase |
| `src/entry/task-factory.ts` | Default profile to `'standard'` in new tasks |
| `src/agent/tools/task-tool.ts` | Add optional `profile` param to create_task tool |
| `tasks/task.schema.json` | Add `profile` field to JSON schema (if schema file exists) |
| `tasks/README.md` | Document profile field |

## Implementation Details

### 1. Profile Type and Phase Map

**Pattern to follow**: Existing `PipelinePhase` type in `src/types.ts`

```typescript
export type PipelineProfile = 'tiny' | 'standard' | 'complex';

/** Which phases run for each profile. Order matters — pipeline executes in this order. */
export const PROFILE_PHASES: Record<PipelineProfile, PipelinePhase[]> = {
  tiny: ['implement', 'review', 'close', 'retrospective'],
  standard: ['implement', 'verify', 'review', 'close', 'retrospective'],
  complex: ['implement', 'verify', 'review', 'close', 'retrospective'],
};
```

Add to `TaskJson`:

```typescript
export interface TaskJson {
  // ... existing fields ...
  /** Pipeline profile — determines which phases run (default: 'standard') */
  profile?: PipelineProfile;
}
```

**Key decisions**:
- `profile` is optional with `'standard'` default — existing tasks without the field work unchanged.
- `complex` has the same phases as `standard` for now. The difference is behavioral (done contract required, potentially longer timeouts). Adding a `plan` phase to complex is future work.
- Retrospective always runs regardless of profile. It's appended to every profile's phase list.

### 2. Pipeline Phase Skipping

**Pattern to follow**: Existing `while/switch` loop in `src/pipeline.ts`

**Overview**: Before entering a phase, check if it's in the profile's phase list. If not, skip to the next phase.

```typescript
export async function runPipeline(config: PipelineConfig): Promise<void> {
  const store = new TaskStore(config.taskJsonPath, config.caseRoot);
  const task = await store.read();
  const profile = task.profile ?? 'standard';
  const allowedPhases = new Set(PROFILE_PHASES[profile]);

  let currentPhase: PipelinePhase = determineEntryPhase(task, profile);

  // ... existing setup ...

  while (currentPhase !== 'complete' && currentPhase !== 'abort') {
    // Skip phases not in this profile
    if (!allowedPhases.has(currentPhase) && currentPhase !== 'retrospective') {
      const skipped = currentPhase;
      currentPhase = nextPhaseInProfile(currentPhase, profile);
      log.phase(skipped, 'skipped-by-profile', { profile });
      continue;
    }

    // ... existing switch/case unchanged ...
  }
}

/** Given a phase that was skipped, determine the next phase to try. */
function nextPhaseInProfile(skippedPhase: PipelinePhase, profile: PipelineProfile): PipelinePhase {
  const phases = PROFILE_PHASES[profile];
  // Standard phase order for mapping
  const ORDER: PipelinePhase[] = ['implement', 'verify', 'review', 'close', 'retrospective'];
  const skippedIdx = ORDER.indexOf(skippedPhase);
  // Find the next phase in ORDER that's in this profile
  for (let i = skippedIdx + 1; i < ORDER.length; i++) {
    if (phases.includes(ORDER[i])) return ORDER[i];
  }
  return 'complete';
}
```

**Key decisions**:
- Phase skipping happens at the top of the loop, not inside each case. This keeps the switch/case bodies unchanged.
- `retrospective` is never skipped (explicit check). Even tiny tasks generate retrospective data.
- `nextPhaseInProfile` uses a fixed ORDER array to determine what comes next when a phase is skipped. This is simpler than modifying each case's `nextPhase` return.

### 3. Entry Phase with Profile Awareness

**Pattern to follow**: Existing `determineEntryPhase()` in `src/state/transitions.ts`

Update to accept profile and handle cases where the task's status maps to a skipped phase:

```typescript
export function determineEntryPhase(task: TaskJson, profile?: PipelineProfile): PipelinePhase {
  const resolvedProfile = profile ?? task.profile ?? 'standard';
  const allowedPhases = new Set(PROFILE_PHASES[resolvedProfile]);
  const rawPhase = determineRawEntryPhase(task);

  // If the raw phase is in the profile, use it
  if (allowedPhases.has(rawPhase)) return rawPhase;

  // Otherwise, find the next allowed phase
  const ORDER: PipelinePhase[] = ['implement', 'verify', 'review', 'close', 'retrospective'];
  const rawIdx = ORDER.indexOf(rawPhase);
  for (let i = rawIdx; i < ORDER.length; i++) {
    if (allowedPhases.has(ORDER[i])) return ORDER[i];
  }
  return 'implement'; // Fallback
}

// Renamed from determineEntryPhase — same logic as before
function determineRawEntryPhase(task: TaskJson): PipelinePhase {
  // ... existing switch/case logic unchanged ...
}
```

### 4. Task Factory Default

**Pattern to follow**: Existing defaults in `src/entry/task-factory.ts`

```typescript
const taskJson: TaskJson = {
  // ... existing fields ...
  profile: 'standard', // Default profile
};
```

### 5. Create Task Tool Parameter

**Pattern to follow**: Existing optional params in `src/agent/tools/task-tool.ts`

```typescript
const taskParams = Type.Object({
  // ... existing fields ...
  profile: Type.Optional(Type.Union([
    Type.Literal('tiny'),
    Type.Literal('standard'),
    Type.Literal('complex'),
  ], { description: 'Pipeline profile — tiny (docs/config), standard (bug fixes), complex (multi-file features)' })),
});
```

Pass through to `TaskCreateRequest`.

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
|---|---|---|---|---|
| Profile selection | Wrong profile | Orchestrator misjudges task complexity | Tiny task runs full pipeline (wasted cost) or complex task skips verify (missed issues) | Human can override via task.json edit. Retrospective can flag "task was tiny but ran standard" as a learning. |
| Phase skipping | Revision loop targets skipped phase | Verifier returns revision but verify is skipped in profile | Impossible — if verify is skipped, verifier never runs, so no revision request | Built into the design |
| Entry phase | Status maps to skipped phase | Task resumed with status 'verifying' but profile is 'tiny' | `determineEntryPhase` finds next allowed phase | Handled by profile-aware entry phase logic |

## Testing Requirements

### Unit Tests

| Test File | Coverage |
|---|---|
| `src/pipeline.test.ts` | Profile-based phase skipping |
| `src/state/transitions.test.ts` | Profile-aware entry phase determination |

**Key test cases**:
- `tiny` profile: verify phase skipped, implement → review → close
- `standard` profile: all phases run (backward compat)
- `complex` profile: all phases run (same as standard)
- Task without profile field defaults to `standard`
- Entry phase with `verifying` status + `tiny` profile → skips to `review`
- Phase skip logging includes profile name
- Retrospective runs for all profiles
- Revision loop disabled for `tiny` profile (verify never runs, so no verifier revision)

## Validation Commands

```bash
# Type checking
bun run typecheck

# Unit tests
bun test

# Build
bun run build
```
