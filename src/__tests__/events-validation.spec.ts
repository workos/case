import { describe, test, expect } from 'bun:test';
import { LifecycleValidationError, validateTransition } from '../events/errors.js';
import type { PipelineEvent } from '../events/schema.js';
import type { PipelineState } from '../events/types.js';
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

function makeEvent(partial: Partial<PipelineEvent> & { event: string }): PipelineEvent {
  return {
    ts: '2026-01-01T00:00:01Z',
    sequence: 1,
    runId: 'run-1',
    ...partial,
  } as PipelineEvent;
}

describe('validateTransition', () => {
  describe('pipeline_start', () => {
    test('allows pipeline_start with null state', () => {
      expect(() =>
        validateTransition(
          makeEvent({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
          null,
        ),
      ).not.toThrow();
    });

    test('rejects pipeline_start when pipeline already started', () => {
      expect(() =>
        validateTransition(
          makeEvent({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
          makeState(),
        ),
      ).toThrow(LifecycleValidationError);
    });

    test('error includes "Pipeline already started" reason', () => {
      try {
        validateTransition(
          makeEvent({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
          makeState(),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(LifecycleValidationError);
        expect((e as LifecycleValidationError).reason).toBe('Pipeline already started');
      }
    });
  });

  describe('phase_start', () => {
    test('allows phase_start when no phase is running', () => {
      expect(() =>
        validateTransition(makeEvent({ event: 'phase_start', phase: 'implement', agent: 'implementer' }), makeState()),
      ).not.toThrow();
    });

    test('allows concurrent phase_start when another phase is running (DAG executor)', () => {
      expect(() =>
        validateTransition(
          makeEvent({ event: 'phase_start', phase: 'verify', agent: 'verifier' }),
          makeState({ currentPhase: 'implement_0', runningPhases: new Set(['implement_0']) }),
        ),
      ).not.toThrow();
    });

    test('rejects phase_start when pipeline not started', () => {
      expect(() =>
        validateTransition(makeEvent({ event: 'phase_start', phase: 'implement', agent: 'implementer' }), null),
      ).toThrow(LifecycleValidationError);
    });
  });

  describe('phase_end', () => {
    test('allows phase_end when matching phase is running', () => {
      const phases = new Map([
        [
          'implement_0',
          {
            phase: 'implement' as const,
            agent: 'implementer' as const,
            status: 'running' as const,
            startedAt: '2026-01-01T00:00:00Z',
          },
        ],
      ]);
      expect(() =>
        validateTransition(
          makeEvent({
            event: 'phase_end',
            phase: 'implement',
            agent: 'implementer',
            outcome: 'completed',
            durationMs: 100,
          }),
          makeState({ currentPhase: 'implement_0', runningPhases: new Set(['implement_0']), phases }),
        ),
      ).not.toThrow();
    });

    test('rejects phase_end when no phase is running', () => {
      expect(() =>
        validateTransition(
          makeEvent({
            event: 'phase_end',
            phase: 'implement',
            agent: 'implementer',
            outcome: 'completed',
            durationMs: 100,
          }),
          makeState(),
        ),
      ).toThrow(LifecycleValidationError);
    });

    test('allows phase_end for a different running phase (concurrent execution)', () => {
      const phases = new Map([
        [
          'verify_0',
          {
            phase: 'verify' as const,
            agent: 'verifier' as const,
            status: 'running' as const,
            startedAt: '2026-01-01T00:00:00Z',
          },
        ],
        [
          'implement_0',
          {
            phase: 'implement' as const,
            agent: 'implementer' as const,
            status: 'running' as const,
            startedAt: '2026-01-01T00:00:00Z',
          },
        ],
      ]);
      expect(() =>
        validateTransition(
          makeEvent({
            event: 'phase_end',
            phase: 'implement',
            agent: 'implementer',
            outcome: 'completed',
            durationMs: 100,
          }),
          makeState({ currentPhase: 'verify_0', runningPhases: new Set(['verify_0', 'implement_0']), phases }),
        ),
      ).not.toThrow();
    });
  });

  describe('revision_requested', () => {
    test('allows revision_requested when evaluator has completed', () => {
      const phases = new Map([
        ['implement_0', { phase: 'implement' as const, agent: 'implementer' as const, status: 'completed' as const }],
        ['verify_0', { phase: 'verify' as const, agent: 'verifier' as const, status: 'completed' as const }],
      ]);
      expect(() =>
        validateTransition(
          makeEvent({ event: 'revision_requested', source: 'verifier', cycle: 1, failedCategories: [] }),
          makeState({ phases }),
        ),
      ).not.toThrow();
    });

    test('rejects revision_requested without evaluator output', () => {
      const phases = new Map([
        ['implement_0', { phase: 'implement' as const, agent: 'implementer' as const, status: 'completed' as const }],
      ]);
      expect(() =>
        validateTransition(
          makeEvent({ event: 'revision_requested', source: 'verifier', cycle: 1, failedCategories: [] }),
          makeState({ phases }),
        ),
      ).toThrow(LifecycleValidationError);
    });
  });

  describe('pipeline_end', () => {
    test('allows pipeline_end when pipeline is running', () => {
      expect(() =>
        validateTransition(makeEvent({ event: 'pipeline_end', outcome: 'completed', durationMs: 5000 }), makeState()),
      ).not.toThrow();
    });

    test('rejects pipeline_end when pipeline not started', () => {
      expect(() =>
        validateTransition(makeEvent({ event: 'pipeline_end', outcome: 'completed', durationMs: 5000 }), null),
      ).toThrow(LifecycleValidationError);
    });
  });

  describe('events after pipeline_end', () => {
    test('rejects any event after pipeline has ended', () => {
      const terminalState = makeState({ outcome: 'completed' });
      expect(() =>
        validateTransition(
          makeEvent({ event: 'phase_start', phase: 'implement', agent: 'implementer' }),
          terminalState,
        ),
      ).toThrow(LifecycleValidationError);
    });

    test('error includes "Cannot append events after pipeline end"', () => {
      const terminalState = makeState({ outcome: 'completed' });
      try {
        validateTransition(
          makeEvent({ event: 'phase_start', phase: 'implement', agent: 'implementer' }),
          terminalState,
        );
      } catch (e) {
        expect((e as LifecycleValidationError).reason).toBe('Cannot append events after pipeline end');
      }
    });
  });

  describe('tool events', () => {
    test('allows tool_start when pipeline is running', () => {
      expect(() =>
        validateTransition(
          makeEvent({
            event: 'tool_start',
            phase: 'implement',
            agent: 'implementer',
            toolCallId: 'tc-1',
            tool: 'bash',
            args: 'ls',
          }),
          makeState(),
        ),
      ).not.toThrow();
    });

    test('rejects tool_start when pipeline not started', () => {
      expect(() =>
        validateTransition(
          makeEvent({
            event: 'tool_start',
            phase: 'implement',
            agent: 'implementer',
            toolCallId: 'tc-1',
            tool: 'bash',
            args: 'ls',
          }),
          null,
        ),
      ).toThrow(LifecycleValidationError);
    });
  });

  describe('error shape', () => {
    test('LifecycleValidationError has correct name', () => {
      try {
        validateTransition(
          makeEvent({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
          makeState(),
        );
      } catch (e) {
        expect((e as LifecycleValidationError).name).toBe('LifecycleValidationError');
        expect((e as LifecycleValidationError).event).toBeDefined();
        expect((e as LifecycleValidationError).currentState).toBeDefined();
      }
    });
  });
});
