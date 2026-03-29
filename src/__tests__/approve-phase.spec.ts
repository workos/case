import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { mockSpawnAgent, mockRunScript, mockWriteRunMetrics, mockGetCurrentPromptVersions, mockFindPriorRunId } from './mocks.js';
import type { AgentName, AgentResult, ApprovalDecision, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import type { Notifier } from '../notify.js';

// Suppress unused import warnings — mocks.ts must be imported for its side effects
void mockSpawnAgent; void mockWriteRunMetrics;
void mockGetCurrentPromptVersions; void mockFindPriorRunId;

// --- Mock approval server (I/O boundary — starts real HTTP server) ---
const mockRunApprovalServer = mock<() => Promise<ApprovalDecision>>();
mock.module('../phases/approve-server.js', () => ({
  runApprovalServer: mockRunApprovalServer,
}));

// Evidence assembler is NOT mocked — it uses the already-mocked runScript and store
const { runApprovePhase } = await import('../phases/approve.js');

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

function makeNotifier(): Notifier {
  return {
    send: mock(),
    phaseStart: mock(),
    phaseEnd: mock(),
    askUser: mock(() => Promise.resolve('Reject')),
  };
}

function makeStore(): TaskStore {
  return {
    setStatus: mock(() => Promise.resolve()),
    read: mock(() => Promise.resolve({
      id: 'cli-42',
      status: 'approving',
      created: '2026-03-28T00:00:00Z',
      repo: 'cli',
      branch: 'fix/login',
      issue: 'workos/cli#42',
      agents: {},
      tested: false,
      manualTested: false,
      prUrl: null,
      prNumber: null,
    })),
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
    filesChanged: ['src/foo.ts'],
    testsPassed: true,
    screenshotUrls: [],
    evidenceMarkers: [],
    prUrl: null,
    prNumber: null,
  },
  error: null,
};

describe('runApprovePhase', () => {
  let previousResults: Map<AgentName, AgentResult>;

  beforeEach(() => {
    mockRunApprovalServer.mockReset();
    mockRunScript.mockReset();
    previousResults = new Map();
    previousResults.set('implementer', completedResult);

    // Default git commands return empty results
    mockRunScript.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('approve → close', async () => {
    mockRunApprovalServer.mockImplementation(() =>
      Promise.resolve({ decision: 'approve' }),
    );
    const store = makeStore();
    const output = await runApprovePhase(makeConfig(), store, previousResults, makeNotifier());

    expect(output.nextPhase).toBe('close');
    expect(output.result.status).toBe('completed');
    expect(output.revision).toBeUndefined();
  });

  it('reject → abort', async () => {
    mockRunApprovalServer.mockImplementation(() =>
      Promise.resolve({ decision: 'reject' }),
    );
    const store = makeStore();
    const output = await runApprovePhase(makeConfig(), store, previousResults, makeNotifier());

    expect(output.nextPhase).toBe('abort');
    expect(output.result.status).toBe('failed');
  });

  it('revise with feedback → implement with RevisionRequest', async () => {
    mockRunApprovalServer.mockImplementation(() =>
      Promise.resolve({ decision: 'revise', feedback: 'Fix the error handling' }),
    );
    const store = makeStore();
    const output = await runApprovePhase(makeConfig(), store, previousResults, makeNotifier());

    expect(output.nextPhase).toBe('implement');
    expect(output.revision).toBeDefined();
    expect(output.revision!.source).toBe('human');
    expect(output.revision!.summary).toBe('Fix the error handling');
  });

  it('revise with manualEdit → verify', async () => {
    mockRunApprovalServer.mockImplementation(() =>
      Promise.resolve({ decision: 'revise', feedback: '', manualEdit: true }),
    );
    const store = makeStore();
    const notifier = makeNotifier();
    const output = await runApprovePhase(makeConfig(), store, previousResults, notifier);

    expect(output.nextPhase).toBe('verify');
    expect(output.revision).toBeUndefined();
    expect(output.result.summary).toContain('manually');
  });

  it('sets status to approving', async () => {
    mockRunApprovalServer.mockImplementation(() =>
      Promise.resolve({ decision: 'approve' }),
    );
    const store = makeStore();
    await runApprovePhase(makeConfig(), store, previousResults, makeNotifier());

    expect((store.setStatus as ReturnType<typeof mock>)).toHaveBeenCalledWith('approving');
  });

  it('dry-run skips and proceeds to close', async () => {
    const store = makeStore();
    const output = await runApprovePhase(makeConfig({ dryRun: true }), store, previousResults, makeNotifier());

    expect(output.nextPhase).toBe('close');
    expect(mockRunApprovalServer).not.toHaveBeenCalled();
  });

  it('passes assembled evidence to approval server', async () => {
    mockRunApprovalServer.mockImplementation(() =>
      Promise.resolve({ decision: 'approve' }),
    );
    await runApprovePhase(makeConfig(), makeStore(), previousResults, makeNotifier());

    // Verify the server received evidence with correct task metadata
    const evidence = mockRunApprovalServer.mock.calls[0][0];
    expect(evidence.task.id).toBe('cli-42');
    expect(evidence.task.repo).toBe('cli');
  });

  it('revise without feedback uses default text', async () => {
    mockRunApprovalServer.mockImplementation(() =>
      Promise.resolve({ decision: 'revise' }),
    );
    const output = await runApprovePhase(makeConfig(), makeStore(), previousResults, makeNotifier());

    expect(output.revision!.summary).toBe('No feedback provided');
  });
});
