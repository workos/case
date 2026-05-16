import { describe, test, expect } from 'bun:test';
import { projectTaskJson, projectMetrics, projectMarkers } from '../events/projections.js';
import type { PipelineState, PhaseState } from '../events/types.js';
import type { PlanArtifact } from '../events/plan.js';

const PLAN: PlanArtifact = {
  runId: 'run-1',
  taskId: 'task-1',
  profile: 'standard',
  phases: [],
  revisionBudget: 2,
  modelConfig: {},
  generatedAt: '2026-01-01T00:00:00Z',
};

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    profile: 'standard',
    plan: PLAN,
    status: 'implementing',
    phases: new Map(),
    currentPhase: null,
    revisionCycles: 0,
    pendingRevision: null,
    markers: new Set(),
    outcome: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    lastSequence: 0,
    ...overrides,
  };
}

describe('projectTaskJson', () => {
  test('maps basic state to TaskJson fields', () => {
    const state = makeState({ status: 'reviewing', taskId: 'fix-login' });
    const result = projectTaskJson(state);

    expect(result.id).toBe('fix-login');
    expect(result.status).toBe('reviewing');
    expect(result.tested).toBe(false);
    expect(result.manualTested).toBe(false);
  });

  test('sets tested=true when markers include tested', () => {
    const state = makeState({ markers: new Set(['tested']) });
    const result = projectTaskJson(state);
    expect(result.tested).toBe(true);
  });

  test('maps agent phases from phase states', () => {
    const phases = new Map<string, PhaseState>([
      ['implement_0', { phase: 'implement', agent: 'implementer', status: 'completed', startedAt: '2026-01-01T00:00:01Z', completedAt: '2026-01-01T00:00:10Z' }],
      ['verify_0', { phase: 'verify', agent: 'verifier', status: 'running', startedAt: '2026-01-01T00:00:11Z' }],
    ]);
    const state = makeState({ phases });
    const result = projectTaskJson(state);

    expect(result.agents?.implementer?.status).toBe('completed');
    expect(result.agents?.verifier?.status).toBe('running');
  });

  test('extracts prUrl from close phase result', () => {
    const phases = new Map<string, PhaseState>([
      ['close_0', {
        phase: 'close',
        agent: 'closer',
        status: 'completed',
        result: {
          status: 'completed',
          summary: 'PR created',
          artifacts: { commit: 'abc123', filesChanged: [], testsPassed: true, screenshotUrls: [], evidenceMarkers: [], prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42 },
          error: null,
        },
      }],
    ]);
    const state = makeState({ phases });
    const result = projectTaskJson(state);

    expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(result.prNumber).toBe(42);
  });

  test('excludes retrospective from agents', () => {
    const phases = new Map<string, PhaseState>([
      ['retrospective_0', { phase: 'retrospective', agent: 'retrospective', status: 'completed' }],
    ]);
    const state = makeState({ phases });
    const result = projectTaskJson(state);

    expect(result.agents).toEqual({});
  });
});

describe('projectMetrics', () => {
  test('produces RunMetrics from completed state', () => {
    const phases = new Map<string, PhaseState>([
      ['implement_0', { phase: 'implement', agent: 'implementer', status: 'completed', startedAt: '2026-01-01T00:00:01Z', completedAt: '2026-01-01T00:00:10Z', durationMs: 9000 }],
      ['verify_0', { phase: 'verify', agent: 'verifier', status: 'completed', startedAt: '2026-01-01T00:00:11Z', completedAt: '2026-01-01T00:00:15Z', durationMs: 4000 }],
    ]);
    const state = makeState({
      phases,
      outcome: 'completed',
      completedAt: '2026-01-01T00:01:00Z',
      totalDurationMs: 60000,
    });
    const metrics = projectMetrics(state);

    expect(metrics.runId).toBe('run-1');
    expect(metrics.outcome).toBe('completed');
    expect(metrics.totalDurationMs).toBe(60000);
    expect(metrics.phases).toHaveLength(2);
    expect(metrics.phases[0].phase).toBe('implement');
    expect(metrics.phases[0].durationMs).toBe(9000);
    expect(metrics.profile).toBe('standard');
  });

  test('revision cycle count is reflected', () => {
    const state = makeState({ revisionCycles: 2 });
    const metrics = projectMetrics(state);
    expect(metrics.revisionCycles).toBe(2);
  });

  test('skipped phases appear in evaluatorEffectiveness', () => {
    const phases = new Map<string, PhaseState>([
      ['verify_0', { phase: 'verify', agent: 'verifier', status: 'skipped' }],
    ]);
    const state = makeState({ phases });
    const metrics = projectMetrics(state);
    expect(metrics.evaluatorEffectiveness.skippedPhases).toContain('verify');
  });
});

describe('projectMarkers', () => {
  test('returns tested marker for completed verify', () => {
    const phases = new Map<string, PhaseState>([
      ['verify_0', { phase: 'verify', agent: 'verifier', status: 'completed' }],
    ]);
    const state = makeState({ phases });
    const markers = projectMarkers(state);

    expect(markers).toHaveLength(1);
    expect(markers[0].name).toBe('tested');
    expect(markers[0].path).toContain('tested');
  });

  test('returns reviewed marker for completed review', () => {
    const phases = new Map<string, PhaseState>([
      ['review_0', { phase: 'review', agent: 'reviewer', status: 'completed' }],
    ]);
    const state = makeState({ phases });
    const markers = projectMarkers(state);

    expect(markers).toHaveLength(1);
    expect(markers[0].name).toBe('reviewed');
  });

  test('returns both markers when both phases completed', () => {
    const phases = new Map<string, PhaseState>([
      ['verify_0', { phase: 'verify', agent: 'verifier', status: 'completed' }],
      ['review_0', { phase: 'review', agent: 'reviewer', status: 'completed' }],
    ]);
    const state = makeState({ phases });
    const markers = projectMarkers(state);

    expect(markers).toHaveLength(2);
  });

  test('returns empty for incomplete phases', () => {
    const phases = new Map<string, PhaseState>([
      ['verify_0', { phase: 'verify', agent: 'verifier', status: 'running' }],
    ]);
    const state = makeState({ phases });
    const markers = projectMarkers(state);

    expect(markers).toHaveLength(0);
  });
});
