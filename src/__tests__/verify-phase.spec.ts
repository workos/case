import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mockSpawnAgent, mockRunScript } from './mocks.js';
import type { AgentName, AgentResult, PipelineConfig } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const { runVerifyPhase } = await import('../phases/verify.js');

const tempCaseRoot = join(process.env.TMPDIR ?? '/tmp', `case-verify-test-${Date.now()}`);

async function setupTempFiles() {
  await mkdir(join(tempCaseRoot, 'agents'), { recursive: true });
  await mkdir(join(tempCaseRoot, 'docs/learnings'), { recursive: true });
  await Bun.write(join(tempCaseRoot, 'agents/verifier.md'), '# Verifier');
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

const completedResult: AgentResult = {
  status: 'completed',
  summary: 'Verified',
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
};

describe('runVerifyPhase', () => {
  beforeEach(async () => {
    mockSpawnAgent.mockReset();
    mockRunScript.mockReset();
    mockRunScript.mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });
    await setupTempFiles();
  });

  afterAll(async () => {
    await rm(tempCaseRoot, { recursive: true, force: true });
  });

  it('clean pass (no rubric fails) → nextPhase review, no revision', async () => {
    const result: AgentResult = {
      ...completedResult,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'reproduced-scenario', verdict: 'pass', detail: 'OK' },
          { category: 'exercised-changed-path', verdict: 'pass', detail: 'OK' },
        ],
      },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runVerifyPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('review');
    expect(output.revision).toBeUndefined();
  });

  it('rubric with fails → revision request generated', async () => {
    const result: AgentResult = {
      ...completedResult,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'reproduced-scenario', verdict: 'pass', detail: 'OK' },
          { category: 'edge-case-checked', verdict: 'fail', detail: 'Missing null check' },
        ],
      },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runVerifyPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('review');
    expect(output.revision).toBeDefined();
    expect(output.revision!.source).toBe('verifier');
    expect(output.revision!.failedCategories).toHaveLength(1);
    expect(output.revision!.failedCategories[0].category).toBe('edge-case-checked');
    expect(output.revision!.summary).toContain('edge-case-checked');
    expect(output.revision!.suggestedFocus).toContain('Missing null check');
  });

  it('no rubric → clean pass, no revision', async () => {
    mockSpawnAgent.mockResolvedValue({ raw: '', result: completedResult, durationMs: 100 });

    const store = makeMockStore();
    const output = await runVerifyPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('review');
    expect(output.revision).toBeUndefined();
  });

  it('failed status → abort', async () => {
    const failedResult: AgentResult = {
      ...completedResult,
      status: 'failed',
      error: 'Verifier crashed',
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result: failedResult, durationMs: 100 });

    const store = makeMockStore();
    const output = await runVerifyPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('abort');
    expect(output.revision).toBeUndefined();
  });

  it('dry-run → skip, no revision', async () => {
    const store = makeMockStore();
    const output = await runVerifyPhase(makeConfig({ dryRun: true }), store as any, new Map());

    expect(output.nextPhase).toBe('review');
    expect(output.revision).toBeUndefined();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});
