import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventAppender } from '../events/appender.js';
import { LifecycleValidationError } from '../events/errors.js';
import type { PlanArtifact } from '../events/plan.js';

// Phase 1.3: the appender is now a write-only JSONL sink + state container.
// td-mirror / marker projection moved to node-direct writes — see
// node-projection.spec for that coverage.

const PLAN: PlanArtifact = {
  runId: 'run-1',
  taskId: 'task-1',
  profile: 'standard',
  phases: [],
  revisionBudget: 2,
  modelConfig: {},
  generatedAt: '2026-01-01T00:00:00Z',
};

const tmpDir = resolve(process.env.TMPDIR ?? '/tmp', `case-appender-test-${Date.now()}`);

beforeEach(async () => {
  await mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('EventAppender', () => {
  test('appends valid event sequence to NDJSON file', async () => {
    const appender = new EventAppender(tmpDir, 'task-1', 'run-1');

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });
    await appender.append({
      event: 'phase_end',
      phase: 'implement',
      agent: 'implementer',
      outcome: 'completed',
      durationMs: 1000,
    });

    const content = await readFile(appender.path, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);

    const events = lines.map((l) => JSON.parse(l));
    expect(events[0].event).toBe('pipeline_start');
    expect(events[1].event).toBe('phase_start');
    expect(events[2].event).toBe('phase_end');
  });

  test('assigns monotonically increasing sequence numbers', async () => {
    const appender = new EventAppender(tmpDir, 'task-1', 'run-2');

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });

    const content = await readFile(appender.path, 'utf-8');
    const events = content
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
  });

  test('assigns consistent runId across all events', async () => {
    const appender = new EventAppender(tmpDir, 'task-1', 'run-3');

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });

    const content = await readFile(appender.path, 'utf-8');
    const events = content
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    expect(events[0].runId).toBe('run-3');
    expect(events[1].runId).toBe('run-3');
  });

  test('allows concurrent phase starts (pipeline executor)', async () => {
    const appender = new EventAppender(tmpDir, 'task-1', 'run-4');

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });

    // Pipeline executor may start multiple phases concurrently
    await expect(
      appender.append({ event: 'phase_start', phase: 'verify', agent: 'verifier' }),
    ).resolves.toBeUndefined();
  });

  test('rejects events after pipeline end', async () => {
    const appender = new EventAppender(tmpDir, 'task-1', 'run-4b');

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await appender.append({ event: 'pipeline_end', outcome: 'completed', durationMs: 100 });

    await expect(appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' })).rejects.toThrow(
      LifecycleValidationError,
    );
  });

  test('updates in-memory state after each append', async () => {
    const appender = new EventAppender(tmpDir, 'task-1', 'run-5');

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });

    const state = appender.getState();
    expect(state.runId).toBe('run-5');
    expect(state.outcome).toBe('running');

    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });
    expect(appender.getState().currentPhase).toBe('implement_0');
  });

  test('throws when getState called before any events', () => {
    const appender = new EventAppender(tmpDir, 'task-1', 'run-7');

    expect(() => appender.getState()).toThrow('No events appended yet');
  });
});
