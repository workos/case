import { describe, test, expect } from 'vitest';
import { phaseStatus } from '../langgraph/engine.js';
import type { CaseGraphStateType, LastPhase } from '../langgraph/state.js';

/**
 * Ported from the legacy `dag-status.spec` (`projectStatusFromGraph`). The
 * LangGraph engine emits a TaskStatus per running phase via `phaseStatus`
 * rather than projecting from a node graph, so this asserts the phase→status
 * mapping the td mirror keys off. The legacy concurrent `evaluating` and the
 * graph-derived terminal `merged` states are intentionally not part of this map
 * (RFC §0 1.1 deviation 3): the sequential engine never runs verify+review
 * concurrently, and run completion is recorded via `pipeline_end`, not a status.
 */
function makeState(last: LastPhase | null = null): CaseGraphStateType {
  return {
    cycle: 0,
    revisionCycles: 0,
    pendingRevision: null,
    fingerprints: {},
    last,
    evaluator: null,
    decision: null,
    revisionClosed: false,
  };
}

describe('phaseStatus', () => {
  test('implement → implementing', () => {
    expect(phaseStatus('implement', makeState())).toBe('implementing');
  });

  test('verify → verifying', () => {
    expect(phaseStatus('verify', makeState())).toBe('verifying');
  });

  test('review → reviewing', () => {
    expect(phaseStatus('review', makeState())).toBe('reviewing');
  });

  test('close → closing', () => {
    expect(phaseStatus('close', makeState())).toBe('closing');
  });

  test('scout has no dedicated status (run stays active)', () => {
    expect(phaseStatus('scout', makeState())).toBeNull();
  });

  test('retrospective after a completed close → pr-opened', () => {
    const state = makeState({ phase: 'close', status: 'completed', rubricFailed: false });
    expect(phaseStatus('retrospective', state)).toBe('pr-opened');
  });

  test('retrospective on a failure path (close did not complete) → no status', () => {
    const state = makeState({ phase: 'implement', status: 'failed', rubricFailed: false });
    expect(phaseStatus('retrospective', state)).toBeNull();
  });
});
