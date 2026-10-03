import { describe, test, expect, afterAll, beforeEach, vi } from 'vitest';
import { mkdir, rm, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectNodeState } from '../langgraph/projection.js';
import type { TaskStore } from '../state/task-store.js';
import type { PipelineState, PhaseState } from '../events/types.js';
import type { PlanArtifact } from '../events/plan.js';

// Phase 1.3 step 2: the td mirror + evidence markers are written node-direct by
// the LangGraph engine via projectNodeState (relocated from EventAppender). This
// asserts the relocated write actually hits td and drops marker files — the
// guarantee §9 flags as must-stay-tested (markers are the evidence gates).

const PLAN: PlanArtifact = {
  runId: 'run-1',
  taskId: 'task-1',
  profile: 'standard',
  phases: [],
  revisionBudget: 2,
  modelConfig: {},
  generatedAt: '2026-01-01T00:00:00Z',
};

const tmpDir = resolve(process.env.TMPDIR ?? '/tmp', `case-node-projection-${Date.now()}`);

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    profile: 'standard',
    plan: PLAN,
    status: 'verifying',
    phases: new Map(),
    currentPhase: null,
    runningPhases: new Set(),
    revisionCycles: 0,
    pendingRevision: null,
    markers: new Set(),
    outcome: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    lastSequence: 0,
    ...overrides,
  };
}

function makeStore() {
  const writeFromProjection = vi.fn(() => Promise.resolve(undefined));
  return { store: { writeFromProjection } as unknown as TaskStore, writeFromProjection };
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('projectNodeState', () => {
  test('writes the td mirror from current pipeline state', async () => {
    const { store, writeFromProjection } = makeStore();
    const state = makeState({ status: 'reviewing' });

    await projectNodeState(state, store, tmpDir);

    expect(writeFromProjection).toHaveBeenCalled();
    const projected = writeFromProjection.mock.calls[0][0] as { id: string; status: string };
    expect(projected.id).toBe('task-1');
    expect(projected.status).toBe('reviewing');
  });

  test('drops the tested marker file when verify completed', async () => {
    const { store } = makeStore();
    const phases = new Map<string, PhaseState>([
      ['verify_0', { phase: 'verify', agent: 'verifier', status: 'completed' }],
    ]);
    const state = makeState({ phases });

    await projectNodeState(state, store, tmpDir);

    const markerPath = resolve(tmpDir, '.case/task-1/tested');
    expect(await exists(markerPath)).toBe(true);
    expect((await readFile(markerPath, 'utf-8')).length).toBeGreaterThan(0);
    // marker recorded in state so it isn't re-written
    expect(state.markers.has('tested')).toBe(true);
  });

  test('drops the reviewed marker file when review completed', async () => {
    const { store } = makeStore();
    const phases = new Map<string, PhaseState>([
      ['review_0', { phase: 'review', agent: 'reviewer', status: 'completed' }],
    ]);
    const state = makeState({ phases });

    await projectNodeState(state, store, tmpDir);

    expect(await exists(resolve(tmpDir, '.case/task-1/reviewed'))).toBe(true);
  });

  test('re-projects td after a marker lands so tested flag is fresh', async () => {
    const { store, writeFromProjection } = makeStore();
    const phases = new Map<string, PhaseState>([
      ['verify_0', { phase: 'verify', agent: 'verifier', status: 'completed' }],
    ]);
    const state = makeState({ phases });

    await projectNodeState(state, store, tmpDir);

    // one write before the marker, one after
    expect(writeFromProjection).toHaveBeenCalledTimes(2);
    const last = writeFromProjection.mock.calls[1][0] as { tested: boolean };
    expect(last.tested).toBe(true);
  });

  test('does not re-write a marker already in state', async () => {
    const { store, writeFromProjection } = makeStore();
    const phases = new Map<string, PhaseState>([
      ['verify_0', { phase: 'verify', agent: 'verifier', status: 'completed' }],
    ]);
    const state = makeState({ phases, markers: new Set(['tested']) });

    await projectNodeState(state, store, tmpDir);

    // marker already present → single td write, no re-projection
    expect(writeFromProjection).toHaveBeenCalledTimes(1);
  });
});
