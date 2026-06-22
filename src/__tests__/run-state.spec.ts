import { describe, test, expect } from 'bun:test';
import { RunState } from '../state/run-state.js';
import type { PlanArtifact } from '../events/plan.js';

/**
 * Phase 2.2 — `RunState` is the state-build oracle that `events-reducer.spec`
 * used to be. The granular event log + `reduceEvents` are gone; the transition
 * logic that builds `PipelineState` now lives in `RunState`'s typed mutators.
 * These assertions are the ported reducer-happy-path / revision / failure cases,
 * driven by method calls instead of events. (Timestamps come from the wall clock
 * now, so duration is asserted via the value passed to `endPhase`, not derived.)
 */

const PLAN: PlanArtifact = {
  runId: 'run-1',
  taskId: 'task-1',
  profile: 'standard',
  phases: [],
  revisionBudget: 2,
  modelConfig: {},
  generatedAt: '2026-01-01T00:00:00Z',
};

function fresh(): RunState {
  return new RunState({ runId: 'run-1', taskId: 'task-1', profile: 'standard', plan: PLAN });
}

describe('RunState', () => {
  test('initial state', () => {
    const s = fresh().getState();
    expect(s.runId).toBe('run-1');
    expect(s.taskId).toBe('task-1');
    expect(s.status).toBe('active');
    expect(s.outcome).toBe('running');
    expect(s.phases.size).toBe(0);
    expect(s.revisionCycles).toBe(0);
  });

  test('happy path: full pipeline lifecycle', () => {
    const rs = fresh();
    for (const [phase, agent, dur] of [
      ['implement', 'implementer', 1000],
      ['verify', 'verifier', 500],
      ['review', 'reviewer', 800],
      ['close', 'closer', 200],
      ['retrospective', 'retrospective', 300],
    ] as const) {
      rs.startPhase(phase, agent);
      rs.endPhase(phase, agent, 'completed', dur);
    }
    rs.end('completed', undefined, 5000);

    const s = rs.getState();
    expect(s.outcome).toBe('completed');
    expect(s.phases.size).toBe(5);
    expect(s.currentPhase).toBeNull();
    expect(s.totalDurationMs).toBe(5000);

    const impl = s.phases.get('implement_0');
    expect(impl?.status).toBe('completed');
    expect(impl?.durationMs).toBe(1000);
  });

  test('crash after implement — outcome still running, implement completed', () => {
    const rs = fresh();
    rs.startPhase('implement', 'implementer');
    rs.endPhase('implement', 'implementer', 'completed', 1000);

    const s = rs.getState();
    expect(s.outcome).toBe('running');
    expect(s.currentPhase).toBeNull();
    expect(s.phases.get('implement_0')?.status).toBe('completed');
  });

  test('requestRevision increments revisionCycles + sets pendingRevision', () => {
    const rs = fresh();
    rs.startPhase('implement', 'implementer');
    rs.endPhase('implement', 'implementer', 'completed', 1000);
    rs.startPhase('verify', 'verifier');
    rs.endPhase('verify', 'verifier', 'completed', 500);
    rs.requestRevision('verifier', 1, []);

    const s = rs.getState();
    expect(s.revisionCycles).toBe(1);
    expect(s.pendingRevision?.source).toBe('verifier');
    expect(s.pendingRevision?.cycle).toBe(1);
  });

  test('cyclic phase keys by revision cycle', () => {
    const rs = fresh();
    rs.startPhase('implement', 'implementer');
    rs.endPhase('implement', 'implementer', 'completed', 100);
    rs.requestRevision('verifier', 1, []);
    rs.startPhase('implement', 'implementer'); // cycle 1

    const s = rs.getState();
    expect(s.phases.has('implement_0')).toBe(true);
    expect(s.phases.has('implement_1')).toBe(true);
  });

  test('setStatus updates status', () => {
    const rs = fresh();
    rs.setStatus('implementing');
    expect(rs.getState().status).toBe('implementing');
  });

  test('end with failure records failedAgent', () => {
    const rs = fresh();
    rs.end('failed', 'verifier', 3000);
    const s = rs.getState();
    expect(s.outcome).toBe('failed');
    expect(s.failedAgent).toBe('verifier');
    expect(s.totalDurationMs).toBe(3000);
  });

  test('seedRevision seeds cycle count + pending revision for a resumed run', () => {
    const rs = fresh();
    rs.seedRevision({ source: 'reviewer', failedCategories: [], summary: '', suggestedFocus: [], cycle: 2 });
    const s = rs.getState();
    expect(s.revisionCycles).toBe(2);
    expect(s.pendingRevision?.source).toBe('reviewer');
  });
});
