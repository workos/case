import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { mockSpawnAgent, mockRunScript, mockWriteRunMetrics, mockGetCurrentPromptVersions, mockFindPriorRunId } from './mocks.js';
import type { AgentName, AgentResult, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import type { Notifier } from '../notify.js';
import { runApprovePhase } from '../phases/approve.js';

// Suppress unused import warnings — mocks.ts must be imported for its side effects
void mockSpawnAgent; void mockRunScript; void mockWriteRunMetrics;
void mockGetCurrentPromptVersions; void mockFindPriorRunId;

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'attended',
    taskJsonPath: '/tmp/test.task.json',
    taskMdPath: '/tmp/test.md',
    repoPath: '/repos/cli',
    repoName: 'cli',
    caseRoot: '/tmp/case',
    maxRetries: 1,
    dryRun: false,
    approve: true,
    ...overrides,
  };
}

function makeNotifier(askUserReturn: string): Notifier {
  return {
    send: mock(),
    phaseStart: mock(),
    phaseEnd: mock(),
    askUser: mock(() => Promise.resolve(askUserReturn)),
  };
}

function makeStore(): TaskStore {
  return {
    setStatus: mock(() => Promise.resolve()),
    read: mock(),
    readStatus: mock(),
    setAgentPhase: mock(),
    setField: mock(),
    setPendingRevision: mock(),
  } as unknown as TaskStore;
}

const completedResult: AgentResult = {
  status: 'completed',
  summary: 'Done',
  artifacts: {
    commit: 'abc123',
    filesChanged: ['src/foo.ts', 'src/bar.ts'],
    testsPassed: true,
    screenshotUrls: [],
    evidenceMarkers: [],
    prUrl: null,
    prNumber: null,
  },
  error: null,
};

const verifierResult: AgentResult = {
  ...completedResult,
  rubric: {
    role: 'verifier',
    categories: [
      { category: 'reproduced-scenario', verdict: 'pass', detail: 'OK' },
      { category: 'edge-case-checked', verdict: 'pass', detail: 'OK' },
    ],
  },
};

const reviewerResult: AgentResult = {
  ...completedResult,
  findings: { critical: 0, warnings: 1, info: 2, details: [] },
  rubric: {
    role: 'reviewer',
    categories: [
      { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
      { category: 'test-sufficiency', verdict: 'pass', detail: 'OK' },
      { category: 'scope-discipline', verdict: 'fail', detail: 'Minor scope creep' },
    ],
  },
};

describe('runApprovePhase', () => {
  let previousResults: Map<AgentName, AgentResult>;

  beforeEach(() => {
    previousResults = new Map();
    previousResults.set('implementer', completedResult);
    previousResults.set('verifier', verifierResult);
    previousResults.set('reviewer', reviewerResult);
  });

  it('prints evidence summary with file count, test status, rubric results', async () => {
    const notifier = makeNotifier('Approve');
    const store = makeStore();

    await runApprovePhase(makeConfig(), store, previousResults, notifier);

    const sendCalls = (notifier.send as ReturnType<typeof mock>).mock.calls;
    const summaryCall = sendCalls.find((c: any) => (c[0] as string).includes('Approval Gate'));
    expect(summaryCall).toBeDefined();

    const summary = summaryCall![0] as string;
    expect(summary).toContain('Files changed: 2');
    expect(summary).toContain('Tests: passed');
    expect(summary).toContain('Verifier: 2/2 categories pass');
    expect(summary).toContain('Reviewer: 0 critical, 1 warnings');
  });

  it('approve → close', async () => {
    const notifier = makeNotifier('Approve');
    const store = makeStore();

    const output = await runApprovePhase(makeConfig(), store, previousResults, notifier);

    expect(output.nextPhase).toBe('close');
    expect(output.result.status).toBe('completed');
    expect(output.revision).toBeUndefined();
  });

  it('reject → abort', async () => {
    const notifier = makeNotifier('Reject');
    const store = makeStore();

    const output = await runApprovePhase(makeConfig(), store, previousResults, notifier);

    expect(output.nextPhase).toBe('abort');
    expect(output.result.status).toBe('failed');
  });

  it('sets status to approving', async () => {
    const notifier = makeNotifier('Approve');
    const store = makeStore();

    await runApprovePhase(makeConfig(), store, previousResults, notifier);

    expect((store.setStatus as ReturnType<typeof mock>)).toHaveBeenCalledWith('approving');
  });

  it('dry-run skips and proceeds to close', async () => {
    const notifier = makeNotifier('Reject'); // would reject if it ran
    const store = makeStore();

    const output = await runApprovePhase(makeConfig({ dryRun: true }), store, previousResults, notifier);

    expect(output.nextPhase).toBe('close');
    expect((notifier.askUser as ReturnType<typeof mock>)).not.toHaveBeenCalled();
  });

  it('handles missing verifier result gracefully', async () => {
    previousResults.delete('verifier');
    const notifier = makeNotifier('Approve');
    const store = makeStore();

    const output = await runApprovePhase(makeConfig(), store, previousResults, notifier);

    expect(output.nextPhase).toBe('close');
    const summaryCall = (notifier.send as ReturnType<typeof mock>).mock.calls.find(
      (c: any) => (c[0] as string).includes('Approval Gate'),
    );
    expect(summaryCall![0] as string).toContain('Verifier: skipped');
  });

  it('handles missing all previous results gracefully', async () => {
    const emptyResults = new Map<AgentName, AgentResult>();
    const notifier = makeNotifier('Approve');
    const store = makeStore();

    const output = await runApprovePhase(makeConfig(), store, emptyResults, notifier);

    expect(output.nextPhase).toBe('close');
    const summaryCall = (notifier.send as ReturnType<typeof mock>).mock.calls.find(
      (c: any) => (c[0] as string).includes('Approval Gate'),
    );
    const summary = summaryCall![0] as string;
    expect(summary).toContain('Files changed: 0');
    expect(summary).toContain('Tests: N/A');
  });
});
