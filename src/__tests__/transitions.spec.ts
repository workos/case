import { describe, it, expect } from 'bun:test';
import { determineEntryPhase } from '../state/transitions.js';
import type { TaskJson } from '../types.js';

function makeTask(overrides: Partial<TaskJson> = {}): TaskJson {
  return {
    id: 'test-1',
    status: 'active',
    created: '2026-03-14T00:00:00Z',
    repo: 'cli',
    agents: {},
    tested: false,
    manualTested: false,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

describe('determineEntryPhase', () => {
  it('active -> implement', () => {
    expect(determineEntryPhase(makeTask({ status: 'active' }))).toBe('implement');
  });

  it('implementing with implementer completed -> verify', () => {
    const task = makeTask({
      status: 'implementing',
      agents: {
        implementer: { started: '2026-03-14T00:00:00Z', completed: '2026-03-14T00:01:00Z', status: 'completed' },
      },
    });
    expect(determineEntryPhase(task)).toBe('verify');
  });

  it('implementing with implementer running -> implement', () => {
    const task = makeTask({
      status: 'implementing',
      agents: { implementer: { started: '2026-03-14T00:00:00Z', completed: null, status: 'running' } },
    });
    expect(determineEntryPhase(task)).toBe('implement');
  });

  it('implementing with implementer failed -> implement', () => {
    const task = makeTask({
      status: 'implementing',
      agents: { implementer: { started: '2026-03-14T00:00:00Z', completed: null, status: 'failed' } },
    });
    expect(determineEntryPhase(task)).toBe('implement');
  });

  it('implementing with no agent data -> implement', () => {
    const task = makeTask({ status: 'implementing', agents: {} });
    expect(determineEntryPhase(task)).toBe('implement');
  });

  it('verifying with verifier completed -> review', () => {
    const task = makeTask({
      status: 'verifying',
      agents: { verifier: { started: '2026-03-14T00:00:00Z', completed: '2026-03-14T00:01:00Z', status: 'completed' } },
    });
    expect(determineEntryPhase(task)).toBe('review');
  });

  it('verifying with verifier not completed -> verify', () => {
    const task = makeTask({
      status: 'verifying',
      agents: { verifier: { started: '2026-03-14T00:00:00Z', completed: null, status: 'running' } },
    });
    expect(determineEntryPhase(task)).toBe('verify');
  });

  it('reviewing with reviewer completed -> close', () => {
    const task = makeTask({
      status: 'reviewing',
      agents: { reviewer: { started: '2026-03-14T00:00:00Z', completed: '2026-03-14T00:01:00Z', status: 'completed' } },
    });
    expect(determineEntryPhase(task)).toBe('close');
  });

  it('reviewing with reviewer not completed -> review', () => {
    const task = makeTask({
      status: 'reviewing',
      agents: { reviewer: { started: null, completed: null, status: 'pending' } },
    });
    expect(determineEntryPhase(task)).toBe('review');
  });

  it('closing -> close', () => {
    expect(determineEntryPhase(makeTask({ status: 'closing' }))).toBe('close');
  });

  it('pr-opened -> complete', () => {
    expect(determineEntryPhase(makeTask({ status: 'pr-opened' }))).toBe('complete');
  });

  it('merged -> complete', () => {
    expect(determineEntryPhase(makeTask({ status: 'merged' }))).toBe('complete');
  });

  // Profile-aware tests
  it('tiny profile: verifying status -> skips to review', () => {
    const task = makeTask({
      status: 'verifying',
      profile: 'tiny',
      agents: { verifier: { started: null, completed: null, status: 'running' } },
    });
    expect(determineEntryPhase(task, 'tiny')).toBe('review');
  });

  it('tiny profile: implementing with completed implementer -> skips verify to review', () => {
    const task = makeTask({
      status: 'implementing',
      profile: 'tiny',
      agents: { implementer: { started: '2026-03-14T00:00:00Z', completed: '2026-03-14T00:01:00Z', status: 'completed' } },
    });
    // Raw phase would be 'verify', but tiny skips it -> review
    expect(determineEntryPhase(task, 'tiny')).toBe('review');
  });

  it('standard profile: verifying status -> verify (no skip)', () => {
    const task = makeTask({
      status: 'verifying',
      agents: { verifier: { started: null, completed: null, status: 'running' } },
    });
    expect(determineEntryPhase(task, 'standard')).toBe('verify');
  });

  it('no profile defaults to standard', () => {
    const task = makeTask({ status: 'active' });
    expect(determineEntryPhase(task)).toBe('implement');
  });

  it('terminal phases pass through regardless of profile', () => {
    expect(determineEntryPhase(makeTask({ status: 'pr-opened' }), 'tiny')).toBe('complete');
    expect(determineEntryPhase(makeTask({ status: 'merged' }), 'tiny')).toBe('complete');
  });
});
