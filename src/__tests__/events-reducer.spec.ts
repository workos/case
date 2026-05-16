import { describe, test, expect, afterAll } from 'bun:test';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { reduceEvents, loadEventsFromFile } from '../events/reducer.js';
import type { PipelineEvent } from '../events/schema.js';
import type { PlanArtifact } from '../events/plan.js';

const PLAN: PlanArtifact = {
  runId: 'run-1',
  taskId: 'task-1',
  profile: 'standard',
  phases: [
    { phase: 'implement', agent: 'implementer', evidenceGates: ['commit'] },
    { phase: 'verify', agent: 'verifier', evidenceGates: ['tested'] },
    { phase: 'review', agent: 'reviewer', evidenceGates: ['reviewed'] },
    { phase: 'close', agent: 'closer', evidenceGates: ['pr-opened'] },
    { phase: 'retrospective', agent: 'retrospective', evidenceGates: [] },
  ],
  revisionBudget: 2,
  modelConfig: {},
  generatedAt: '2026-01-01T00:00:00Z',
};

function makeEvent(seq: number, partial: Partial<PipelineEvent> & { event: string }): PipelineEvent {
  return {
    ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    sequence: seq,
    runId: 'run-1',
    ...partial,
  } as PipelineEvent;
}

const tmpDir = resolve(process.env.TMPDIR ?? '/tmp', `case-reducer-test-${Date.now()}`);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('reduceEvents', () => {
  test('happy path: full pipeline lifecycle', () => {
    const events: PipelineEvent[] = [
      makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
      makeEvent(2, { event: 'phase_start', phase: 'implement', agent: 'implementer' }),
      makeEvent(3, {
        event: 'phase_end',
        phase: 'implement',
        agent: 'implementer',
        outcome: 'completed',
        durationMs: 1000,
      }),
      makeEvent(4, { event: 'phase_start', phase: 'verify', agent: 'verifier' }),
      makeEvent(5, { event: 'phase_end', phase: 'verify', agent: 'verifier', outcome: 'completed', durationMs: 500 }),
      makeEvent(6, { event: 'phase_start', phase: 'review', agent: 'reviewer' }),
      makeEvent(7, { event: 'phase_end', phase: 'review', agent: 'reviewer', outcome: 'completed', durationMs: 800 }),
      makeEvent(8, { event: 'phase_start', phase: 'close', agent: 'closer' }),
      makeEvent(9, { event: 'phase_end', phase: 'close', agent: 'closer', outcome: 'completed', durationMs: 200 }),
      makeEvent(10, { event: 'phase_start', phase: 'retrospective', agent: 'retrospective' }),
      makeEvent(11, {
        event: 'phase_end',
        phase: 'retrospective',
        agent: 'retrospective',
        outcome: 'completed',
        durationMs: 300,
      }),
      makeEvent(12, { event: 'pipeline_end', outcome: 'completed', durationMs: 5000 }),
    ];

    const state = reduceEvents(events);

    expect(state.runId).toBe('run-1');
    expect(state.taskId).toBe('task-1');
    expect(state.outcome).toBe('completed');
    expect(state.phases.size).toBe(5);
    expect(state.currentPhase).toBeNull();
    expect(state.lastSequence).toBe(12);
    expect(state.totalDurationMs).toBe(5000);

    const impl = state.phases.get('implement_0');
    expect(impl?.status).toBe('completed');
    expect(impl?.durationMs).toBe(1000);
  });

  test('crash after implement — verify is pending', () => {
    const events: PipelineEvent[] = [
      makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
      makeEvent(2, { event: 'phase_start', phase: 'implement', agent: 'implementer' }),
      makeEvent(3, {
        event: 'phase_end',
        phase: 'implement',
        agent: 'implementer',
        outcome: 'completed',
        durationMs: 1000,
      }),
    ];

    const state = reduceEvents(events);

    expect(state.outcome).toBe('running');
    expect(state.currentPhase).toBeNull();
    expect(state.phases.get('implement_0')?.status).toBe('completed');
    expect(state.lastSequence).toBe(3);
  });

  test('revision cycle increments revisionCycles', () => {
    const events: PipelineEvent[] = [
      makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
      makeEvent(2, { event: 'phase_start', phase: 'implement', agent: 'implementer' }),
      makeEvent(3, {
        event: 'phase_end',
        phase: 'implement',
        agent: 'implementer',
        outcome: 'completed',
        durationMs: 1000,
      }),
      makeEvent(4, { event: 'phase_start', phase: 'verify', agent: 'verifier' }),
      makeEvent(5, { event: 'phase_end', phase: 'verify', agent: 'verifier', outcome: 'completed', durationMs: 500 }),
      makeEvent(6, { event: 'revision_requested', source: 'verifier', cycle: 1, failedCategories: [] }),
    ];

    const state = reduceEvents(events);

    expect(state.revisionCycles).toBe(1);
    expect(state.pendingRevision).not.toBeNull();
    expect(state.pendingRevision?.source).toBe('verifier');
    expect(state.lastSequence).toBe(6);
  });

  test('status_changed updates status', () => {
    const events: PipelineEvent[] = [
      makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
      makeEvent(2, { event: 'status_changed', from: 'active', to: 'implementing' }),
    ];

    const state = reduceEvents(events);
    expect(state.status).toBe('implementing');
  });

  test('marker_written adds to markers set', () => {
    const events: PipelineEvent[] = [
      makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
      makeEvent(2, { event: 'marker_written', marker: 'tested', path: '.case/task-1/tested' }),
    ];

    const state = reduceEvents(events);
    expect(state.markers.has('tested')).toBe(true);
  });

  test('pipeline_end with failure records failedAgent', () => {
    const events: PipelineEvent[] = [
      makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
      makeEvent(2, { event: 'pipeline_end', outcome: 'failed', failedAgent: 'verifier', durationMs: 3000 }),
    ];

    const state = reduceEvents(events);
    expect(state.outcome).toBe('failed');
    expect(state.failedAgent).toBe('verifier');
  });

  test('tool events update lastSequence without changing state', () => {
    const events: PipelineEvent[] = [
      makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
      makeEvent(2, {
        event: 'tool_start',
        phase: 'implement',
        agent: 'implementer',
        toolCallId: 'tc-1',
        tool: 'bash',
        args: 'ls',
      }),
      makeEvent(3, {
        event: 'tool_end',
        phase: 'implement',
        agent: 'implementer',
        toolCallId: 'tc-1',
        tool: 'bash',
        durationMs: 50,
        isError: false,
        result: 'ok',
      }),
    ];

    const state = reduceEvents(events);
    expect(state.lastSequence).toBe(3);
    expect(state.phases.size).toBe(0);
  });

  test('throws on empty event array', () => {
    expect(() => reduceEvents([])).toThrow('No events to reduce');
  });

  test('lastSequence matches highest sequence in input', () => {
    const events: PipelineEvent[] = [
      makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
      makeEvent(5, { event: 'phase_start', phase: 'implement', agent: 'implementer' }),
      makeEvent(10, {
        event: 'phase_end',
        phase: 'implement',
        agent: 'implementer',
        outcome: 'completed',
        durationMs: 100,
      }),
    ];

    const state = reduceEvents(events);
    expect(state.lastSequence).toBe(10);
  });
});

describe('loadEventsFromFile', () => {
  test('loads valid NDJSON events', async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = resolve(tmpDir, 'events.jsonl');

    const events = [
      makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN }),
      makeEvent(2, { event: 'phase_start', phase: 'implement', agent: 'implementer' }),
    ];

    await writeFile(filePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const loaded = await loadEventsFromFile(filePath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].event).toBe('pipeline_start');
    expect(loaded[1].event).toBe('phase_start');
  });

  test('skips corrupted trailing line', async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = resolve(tmpDir, 'events-corrupt.jsonl');

    const validEvent = makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await writeFile(filePath, JSON.stringify(validEvent) + '\n' + '{"broken json');

    const loaded = await loadEventsFromFile(filePath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].event).toBe('pipeline_start');
  });

  test('skips empty lines', async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = resolve(tmpDir, 'events-empty-lines.jsonl');

    const event = makeEvent(1, { event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await writeFile(filePath, '\n' + JSON.stringify(event) + '\n\n');

    const loaded = await loadEventsFromFile(filePath);
    expect(loaded).toHaveLength(1);
  });
});
