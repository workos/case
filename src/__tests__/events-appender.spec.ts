import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventAppender } from '../events/appender.js';
import { LifecycleValidationError } from '../events/errors.js';
import type { PlanArtifact } from '../events/plan.js';
import type { TaskJson } from '../types.js';

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
let taskJsonPath: string;
let writtenProjections: Array<Partial<TaskJson>>;

class MockTaskStore {
  taskJsonPath: string;

  constructor(path: string) {
    this.taskJsonPath = path;
  }

  async read(): Promise<TaskJson> {
    const raw = await readFile(this.taskJsonPath, 'utf-8');
    return JSON.parse(raw);
  }

  async writeFromProjection(projected: Partial<TaskJson>): Promise<void> {
    writtenProjections.push(projected);
    const task = await this.read();
    Object.assign(task, projected);
    await writeFile(this.taskJsonPath, JSON.stringify(task, null, 2) + '\n');
  }

  async readStatus() {
    return (await this.read()).status;
  }
  async setStatus() {}
  async setAgentPhase() {}
  async setField() {}
  async setPendingRevision() {}
}

beforeEach(async () => {
  writtenProjections = [];
  await mkdir(tmpDir, { recursive: true });
  taskJsonPath = resolve(tmpDir, '.task.json');
  await writeFile(
    taskJsonPath,
    JSON.stringify(
      {
        id: 'task-1',
        status: 'active',
        created: '2026-01-01T00:00:00Z',
        repo: 'test-repo',
        agents: {},
        tested: false,
        manualTested: false,
        prUrl: null,
        prNumber: null,
      },
      null,
      2,
    ) + '\n',
  );
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('EventAppender', () => {
  test('appends valid event sequence to NDJSON file', async () => {
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-1', store);

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
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-2', store);

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
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-3', store);

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

  test('rejects invalid transition and does NOT modify file', async () => {
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-4', store);

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });

    const contentBefore = await readFile(appender.path, 'utf-8');

    await expect(appender.append({ event: 'phase_start', phase: 'verify', agent: 'verifier' })).rejects.toThrow(
      LifecycleValidationError,
    );

    const contentAfter = await readFile(appender.path, 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  test('updates in-memory state after each append', async () => {
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-5', store);

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });

    const state = appender.getState();
    expect(state.runId).toBe('run-5');
    expect(state.outcome).toBe('running');

    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });
    expect(appender.getState().currentPhase).toBe('implement_0');
  });

  test('calls writeFromProjection on TaskStore after each event', async () => {
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-6', store);

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });

    expect(writtenProjections.length).toBeGreaterThanOrEqual(2);
  });

  test('throws when getState called before any events', () => {
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-7', store);

    expect(() => appender.getState()).toThrow('No events appended yet');
  });

  test('writes tested marker file on verify phase_end completed', async () => {
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-marker-1', store);

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });
    await appender.append({
      event: 'phase_end',
      phase: 'implement',
      agent: 'implementer',
      outcome: 'completed',
      durationMs: 100,
    });
    await appender.append({ event: 'phase_start', phase: 'verify', agent: 'verifier' });
    await appender.append({
      event: 'phase_end',
      phase: 'verify',
      agent: 'verifier',
      outcome: 'completed',
      durationMs: 100,
    });

    const { existsSync } = await import('node:fs');
    const markerPath = resolve(tmpDir, '.case/task-1/tested');
    expect(existsSync(markerPath)).toBe(true);

    expect(appender.getState().markers.has('tested')).toBe(true);

    const lastProjection = writtenProjections[writtenProjections.length - 1];
    expect(lastProjection.tested).toBe(true);
  });

  test('writes reviewed marker file on review phase_end completed', async () => {
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-marker-2', store);

    await appender.append({ event: 'pipeline_start', taskId: 'task-1', profile: 'standard', plan: PLAN });
    await appender.append({ event: 'phase_start', phase: 'implement', agent: 'implementer' });
    await appender.append({
      event: 'phase_end',
      phase: 'implement',
      agent: 'implementer',
      outcome: 'completed',
      durationMs: 100,
    });
    await appender.append({ event: 'phase_start', phase: 'verify', agent: 'verifier' });
    await appender.append({
      event: 'phase_end',
      phase: 'verify',
      agent: 'verifier',
      outcome: 'completed',
      durationMs: 100,
    });
    await appender.append({ event: 'phase_start', phase: 'review', agent: 'reviewer' });
    await appender.append({
      event: 'phase_end',
      phase: 'review',
      agent: 'reviewer',
      outcome: 'completed',
      durationMs: 100,
    });

    const { existsSync } = await import('node:fs');
    expect(existsSync(resolve(tmpDir, '.case/task-1/reviewed'))).toBe(true);
    expect(appender.getState().markers.has('reviewed')).toBe(true);
  });

  test('restoreState allows resuming from existing state', async () => {
    const store = new MockTaskStore(taskJsonPath) as any;
    const appender = new EventAppender(tmpDir, 'task-1', 'run-8', store);

    const existingState = {
      runId: 'run-8',
      taskId: 'task-1',
      profile: 'standard' as const,
      plan: PLAN,
      status: 'implementing' as const,
      phases: new Map([
        ['implement_0', { phase: 'implement' as const, agent: 'implementer' as const, status: 'completed' as const }],
      ]),
      currentPhase: null,
      revisionCycles: 0,
      pendingRevision: null,
      markers: new Set<string>(),
      outcome: 'running' as const,
      startedAt: '2026-01-01T00:00:00Z',
      lastSequence: 5,
    };

    appender.restoreState(existingState);

    await appender.append({ event: 'phase_start', phase: 'verify', agent: 'verifier' });
    const state = appender.getState();
    expect(state.currentPhase).toBe('verify_0');
  });
});
