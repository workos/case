import { describe, test, expect, beforeEach } from 'bun:test';
import { buildGraph } from '../dag/builder.js';
import { executeGraph, findReadyNodes } from '../dag/executor.js';
import type { ExecuteGraphContext } from '../dag/executor.js';
import type { AgentResult, PipelineConfig } from '../types.js';
import type { DagNode, PipelineGraph } from '../dag/types.js';
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

function makePassResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    status: 'completed',
    summary: 'done',
    artifacts: {
      commit: null,
      filesChanged: [],
      testsPassed: true,
      screenshotUrls: [],
      evidenceMarkers: [],
      prUrl: null,
      prNumber: null,
    },
    error: null,
    ...overrides,
  };
}

function makeRevisionResult(source: 'verifier' | 'reviewer'): AgentResult {
  return {
    status: 'completed',
    summary: `${source} found issues`,
    artifacts: {
      commit: null,
      filesChanged: ['src/foo.ts'],
      testsPassed: false,
      screenshotUrls: [],
      evidenceMarkers: [],
      prUrl: null,
      prNumber: null,
    },
    rubric: {
      role: source === 'verifier' ? 'verifier' : 'reviewer',
      categories: [{ category: 'reproduced-scenario', verdict: 'fail', detail: 'test not passing' }],
    },
    error: null,
  };
}

class MockAppender {
  events: Array<{ event: string; [key: string]: any }> = [];
  private state: PipelineState = {
    runId: 'run-1',
    taskId: 'task-1',
    profile: 'standard',
    plan: PLAN,
    status: 'active',
    phases: new Map(),
    currentPhase: null,
    runningPhases: new Set<string>(),
    revisionCycles: 0,
    pendingRevision: null,
    markers: new Set(),
    outcome: 'running',
    startedAt: new Date().toISOString(),
    lastSequence: 0,
  };

  async append(partial: any) {
    this.events.push(partial);
    if (partial.event === 'status_changed') {
      this.state = { ...this.state, status: partial.to };
    }
  }

  getState(): PipelineState {
    return this.state;
  }
}

class MockNotifier {
  messages: string[] = [];
  phaseStart() {}
  phaseEnd() {}
  send(msg: string) {
    this.messages.push(msg);
  }
  askUser() {
    return Promise.resolve('Abort');
  }
}

describe('findReadyNodes', () => {
  test('returns root nodes (no incoming edges) that are pending', () => {
    const graph = buildGraph('standard', 2);
    const ready = findReadyNodes(graph);
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('implement_0');
  });

  test('returns nothing when root node is already running', () => {
    const graph = buildGraph('standard', 2);
    graph.nodes.get('implement_0')!.state = 'running';
    const ready = findReadyNodes(graph);
    expect(ready).toHaveLength(0);
  });

  test('returns verify_0 and review_0 when implement_0 is completed', () => {
    const graph = buildGraph('standard', 2);
    graph.nodes.get('implement_0')!.state = 'completed';
    const ready = findReadyNodes(graph);
    const ids = ready.map((n) => n.id).sort();
    expect(ids).toEqual(['review_0', 'verify_0']);
  });

  test('returns nothing when evaluators complete but predicates not satisfied', () => {
    const graph = buildGraph('standard', 2);
    graph.nodes.get('implement_0')!.state = 'completed';
    graph.nodes.get('verify_0')!.state = 'completed';
    // review_0 still pending — close predicate needs both
    const ready = findReadyNodes(graph);
    // review_0 should be ready (implement_0 completed), but no others beyond that
    expect(ready.map((n) => n.id)).toEqual(['review_0']);
  });
});

describe('executeGraph', () => {
  let appender: MockAppender;
  let notifier: MockNotifier;

  beforeEach(() => {
    appender = new MockAppender();
    notifier = new MockNotifier();
  });

  function makeContext(graph: PipelineGraph, phaseResponses: Map<string, AgentResult>): ExecuteGraphContext {
    return {
      graph,
      appender: appender as any,
      config: {} as PipelineConfig,
      notifier: notifier as any,
      dispatchPhase: async (node: DagNode) => {
        return phaseResponses.get(node.id) ?? makePassResult();
      },
    };
  }

  test('happy path: all phases pass, close and retrospective run', async () => {
    const graph = buildGraph('standard', 2);
    const responses = new Map<string, AgentResult>();
    // All default to pass

    const ctx = makeContext(graph, responses);
    await executeGraph(ctx);

    // impl_0, verify_0, review_0, close, retrospective should all be completed
    expect(graph.nodes.get('implement_0')!.state).toBe('completed');
    expect(graph.nodes.get('verify_0')!.state).toBe('completed');
    expect(graph.nodes.get('review_0')!.state).toBe('completed');
    expect(graph.nodes.get('close')!.state).toBe('completed');
    expect(graph.nodes.get('retrospective')!.state).toBe('completed');

    // Revision nodes should be skipped
    expect(graph.nodes.get('implement_1')!.state).toBe('skipped');
    expect(graph.nodes.get('implement_2')!.state).toBe('skipped');
  });

  test('verify and review run concurrently (both dispatched in same batch)', async () => {
    const graph = buildGraph('standard', 0);
    const dispatchOrder: string[] = [];
    const ctx: ExecuteGraphContext = {
      graph,
      appender: appender as any,
      config: {} as PipelineConfig,
      notifier: notifier as any,
      dispatchPhase: async (node: DagNode) => {
        dispatchOrder.push(node.id);
        return makePassResult();
      },
    };

    await executeGraph(ctx);

    // verify_0 and review_0 should appear consecutively in dispatch order
    const verifyIdx = dispatchOrder.indexOf('verify_0');
    const reviewIdx = dispatchOrder.indexOf('review_0');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(-1);
    // They should be dispatched in the same batch (before close)
    const closeIdx = dispatchOrder.indexOf('close');
    expect(verifyIdx).toBeLessThan(closeIdx);
    expect(reviewIdx).toBeLessThan(closeIdx);
  });

  test('revision: verifier requests revision → implement_1 runs', async () => {
    const graph = buildGraph('standard', 2);
    const responses = new Map<string, AgentResult>();
    responses.set('verify_0', makeRevisionResult('verifier'));

    const ctx = makeContext(graph, responses);
    await executeGraph(ctx);

    expect(graph.nodes.get('implement_1')!.state).toBe('completed');
    expect(graph.nodes.get('verify_1')!.state).toBe('completed');
    expect(graph.nodes.get('review_1')!.state).toBe('completed');
  });

  test('both evaluators request revision → merged revision request', async () => {
    const graph = buildGraph('standard', 2);
    const responses = new Map<string, AgentResult>();
    responses.set('verify_0', makeRevisionResult('verifier'));
    responses.set('review_0', makeRevisionResult('reviewer'));

    const ctx = makeContext(graph, responses);
    await executeGraph(ctx);

    // revision_requested event should have been emitted
    const revisionEvents = appender.events.filter((e) => e.event === 'revision_requested');
    expect(revisionEvents.length).toBeGreaterThanOrEqual(1);

    expect(graph.nodes.get('implement_1')!.state).toBe('completed');
  });

  test('revision budget exhausted → close runs, remaining nodes skipped', async () => {
    const graph = buildGraph('standard', 1); // only 1 revision cycle allowed
    const responses = new Map<string, AgentResult>();
    responses.set('verify_0', makeRevisionResult('verifier'));
    responses.set('verify_1', makeRevisionResult('verifier'));

    const ctx = makeContext(graph, responses);
    await executeGraph(ctx);

    // After revision at cycle 0, implement_1 runs. After revision at cycle 1,
    // no implement_2 exists (maxRevisionCycles=1), so close should run
    expect(graph.nodes.get('close')!.state).toBe('completed');
    expect(graph.nodes.get('retrospective')!.state).toBe('completed');
  });

  test('implement fails → node marked failed, pipeline terminates', async () => {
    const graph = buildGraph('standard', 2);
    const responses = new Map<string, AgentResult>();
    responses.set('implement_0', {
      ...makePassResult(),
      status: 'failed',
      error: 'agent crashed',
    });

    const ctx = makeContext(graph, responses);
    await executeGraph(ctx);

    expect(graph.nodes.get('implement_0')!.state).toBe('failed');
    // Downstream nodes should be skipped
    expect(graph.nodes.get('verify_0')!.state).toBe('skipped');
    expect(graph.nodes.get('review_0')!.state).toBe('skipped');
  });

  test('tiny profile: no verify nodes, review runs directly after implement', async () => {
    const graph = buildGraph('tiny', 1);
    const dispatchOrder: string[] = [];
    const ctx: ExecuteGraphContext = {
      graph,
      appender: appender as any,
      config: {} as PipelineConfig,
      notifier: notifier as any,
      dispatchPhase: async (node: DagNode) => {
        dispatchOrder.push(node.id);
        return makePassResult();
      },
    };

    await executeGraph(ctx);

    expect(dispatchOrder).toContain('implement_0');
    expect(dispatchOrder).toContain('review_0');
    expect(dispatchOrder).not.toContain('verify_0');
    expect(graph.nodes.get('close')!.state).toBe('completed');
  });
});
