import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mockSpawnAgent, mockRunScript } from './mocks.js';
import type { AgentName, AgentResult, PipelineConfig } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Import the REAL implement phase (no mock.module for phases)
const { runImplementPhase } = await import('../phases/implement.js');

const tempCaseRoot = join(process.env.TMPDIR ?? '/tmp', `case-impl-test-${Date.now()}`);

async function setupTempFiles() {
  await mkdir(join(tempCaseRoot, 'agents'), { recursive: true });
  await mkdir(join(tempCaseRoot, 'docs/learnings'), { recursive: true });
  await Bun.write(join(tempCaseRoot, 'agents/implementer.md'), '# Implementer');
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'attended',
    taskJsonPath: join(tempCaseRoot, 'tasks/active/cli-1.task.json'),
    taskMdPath: join(tempCaseRoot, 'tasks/active/cli-1.md'),
    repoPath: '/repos/cli',
    repoName: 'cli',
    caseRoot: tempCaseRoot,
    maxRetries: 1,
    dryRun: false,
    ...overrides,
  };
}

const completedResult: AgentResult = {
  status: 'completed',
  summary: 'Fixed the bug',
  artifacts: {
    commit: 'abc123',
    filesChanged: ['src/x.ts'],
    testsPassed: true,
    screenshotUrls: [],
    evidenceMarkers: ['.case-tested'],
    prUrl: null,
    prNumber: null,
  },
  error: null,
};

const failedResult: AgentResult = {
  status: 'failed',
  summary: '',
  artifacts: {
    commit: null,
    filesChanged: [],
    testsPassed: false,
    screenshotUrls: [],
    evidenceMarkers: [],
    prUrl: null,
    prNumber: null,
  },
  error: 'Tests failed: 3 failing',
};

function makeMockStore() {
  return {
    read: mock(() =>
      Promise.resolve({
        id: 'cli-1',
        status: 'active',
        created: '2026-03-14T00:00:00Z',
        repo: 'cli',
        agents: {},
        tested: false,
        manualTested: false,
        prUrl: null,
        prNumber: null,
      }),
    ),
    readStatus: mock(() => Promise.resolve('active')),
    setStatus: mock(() => Promise.resolve(undefined)),
    setAgentPhase: mock(() => Promise.resolve(undefined)),
    setField: mock(() => Promise.resolve(undefined)),
  };
}

describe('runImplementPhase', () => {
  beforeEach(async () => {
    mockSpawnAgent.mockReset();
    mockRunScript.mockReset();

    await setupTempFiles();

    // Default: runScript returns empty JSON (for session-start.sh, git log)
    mockRunScript.mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });
  });

  afterAll(async () => {
    await rm(tempCaseRoot, { recursive: true, force: true });
  });

  it('success path -> nextPhase is verify, task state updated', async () => {
    mockSpawnAgent.mockResolvedValue({ raw: '', result: completedResult, durationMs: 1000 });

    const store = makeMockStore();
    const results = new Map<AgentName, AgentResult>();
    const output = await runImplementPhase(makeConfig(), store as any, results);

    expect(output.nextPhase).toBe('verify');
    expect(output.result.status).toBe('completed');
    expect(results.get('implementer')).toBe(completedResult);
    expect(store.setStatus).toHaveBeenCalledWith('implementing');
    expect(store.setAgentPhase).toHaveBeenCalledWith('implementer', 'status', 'running');
    expect(store.setAgentPhase).toHaveBeenCalledWith('implementer', 'started', 'now');
    expect(store.setAgentPhase).toHaveBeenCalledWith('implementer', 'status', 'completed');
    expect(store.setAgentPhase).toHaveBeenCalledWith('implementer', 'completed', 'now');
  });

  it('failure with retryViable=true -> retries once', async () => {
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: '', result: failedResult, durationMs: 1000 })
      .mockResolvedValueOnce({ raw: '', result: completedResult, durationMs: 1000 });

    mockRunScript
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // session-start
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git log
      .mockResolvedValueOnce({
        // analyze-failure
        stdout: JSON.stringify({
          failureClass: 'test-failure',
          failedAgent: 'implementer',
          errorSummary: 'Tests failed',
          filesInvolved: ['src/x.ts'],
          whatWasTried: ['first approach'],
          suggestedFocus: 'Check test expectations',
          retryViable: true,
        }),
        stderr: '',
        exitCode: 0,
      });

    const store = makeMockStore();
    const results = new Map<AgentName, AgentResult>();
    const output = await runImplementPhase(makeConfig(), store as any, results);

    expect(output.nextPhase).toBe('verify');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    const retryCall = mockSpawnAgent.mock.calls[1];
    expect(retryCall[0].prompt).toContain('RETRY CONTEXT');
    expect(retryCall[0].prompt).toContain('test-failure');
  });

  it('failure with retryViable=false -> abort', async () => {
    mockSpawnAgent.mockResolvedValue({ raw: '', result: failedResult, durationMs: 1000 });

    mockRunScript
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          failureClass: 'unknown',
          failedAgent: 'implementer',
          errorSummary: 'Too many attempts',
          filesInvolved: [],
          whatWasTried: ['a', 'b', 'c'],
          suggestedFocus: 'Surface to human',
          retryViable: false,
        }),
        stderr: '',
        exitCode: 0,
      });

    const store = makeMockStore();
    const results = new Map<AgentName, AgentResult>();
    const output = await runImplementPhase(makeConfig(), store as any, results);

    expect(output.nextPhase).toBe('abort');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('retry fails -> abort', async () => {
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: '', result: failedResult, durationMs: 1000 })
      .mockResolvedValueOnce({ raw: '', result: failedResult, durationMs: 1000 });

    mockRunScript
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          failureClass: 'test-failure',
          failedAgent: 'implementer',
          errorSummary: 'Tests failed',
          filesInvolved: [],
          whatWasTried: [],
          suggestedFocus: 'Try different approach',
          retryViable: true,
        }),
        stderr: '',
        exitCode: 0,
      });

    const store = makeMockStore();
    const results = new Map<AgentName, AgentResult>();
    const output = await runImplementPhase(makeConfig(), store as any, results);

    expect(output.nextPhase).toBe('abort');
    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
  });

  it('dry-run mode -> no agents spawned', async () => {
    const store = makeMockStore();
    const results = new Map<AgentName, AgentResult>();
    const output = await runImplementPhase(makeConfig({ dryRun: true }), store as any, results);

    expect(output.nextPhase).toBe('verify');
    expect(output.result.summary).toContain('dry-run');
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});
