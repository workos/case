import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mockSpawnAgent, mockRunScript } from './mocks.js';
import type { AgentName, AgentResult, PipelineConfig } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const { runReviewPhase } = await import('../phases/review.js');

const tempCaseRoot = join(process.env.TMPDIR ?? '/tmp', `case-review-test-${Date.now()}`);

async function setupTempFiles() {
  await mkdir(join(tempCaseRoot, 'agents'), { recursive: true });
  await mkdir(join(tempCaseRoot, 'docs/learnings'), { recursive: true });
  await Bun.write(join(tempCaseRoot, 'agents/reviewer.md'), '# Reviewer');
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
  summary: 'Reviewed',
  artifacts: {
    commit: null,
    filesChanged: [],
    testsPassed: null,
    screenshotUrls: [],
    evidenceMarkers: [],
    prUrl: null,
    prNumber: null,
  },
  error: null,
};

describe('runReviewPhase', () => {
  beforeEach(async () => {
    mockSpawnAgent.mockReset();
    mockRunScript.mockReset();
    mockRunScript.mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });
    await setupTempFiles();
  });

  afterAll(async () => {
    await rm(tempCaseRoot, { recursive: true, force: true });
  });

  it('clean pass (all rubric pass) → nextPhase close, no revision', async () => {
    const result: AgentResult = {
      ...completedResult,
      rubric: {
        role: 'reviewer',
        categories: [
          { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
          { category: 'test-sufficiency', verdict: 'pass', detail: 'OK' },
          { category: 'scope-discipline', verdict: 'pass', detail: 'OK' },
          { category: 'pattern-fit', verdict: 'pass', detail: 'OK' },
        ],
      },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runReviewPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('close');
    expect(output.revision).toBeUndefined();
  });

  it('hard-fail (principle-compliance) → abort, no revision', async () => {
    const result: AgentResult = {
      ...completedResult,
      rubric: {
        role: 'reviewer',
        categories: [
          { category: 'principle-compliance', verdict: 'fail', detail: 'Violates golden principle' },
          { category: 'test-sufficiency', verdict: 'pass', detail: 'OK' },
        ],
      },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runReviewPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('abort');
    expect(output.revision).toBeUndefined();
  });

  it('hard-fail (scope-discipline) → abort, no revision', async () => {
    const result: AgentResult = {
      ...completedResult,
      rubric: {
        role: 'reviewer',
        categories: [
          { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
          { category: 'scope-discipline', verdict: 'fail', detail: 'Out of scope changes' },
        ],
      },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runReviewPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('abort');
    expect(output.revision).toBeUndefined();
  });

  it('soft-fail (test-sufficiency) → revision request', async () => {
    const result: AgentResult = {
      ...completedResult,
      rubric: {
        role: 'reviewer',
        categories: [
          { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
          { category: 'test-sufficiency', verdict: 'fail', detail: 'Missing edge case tests' },
          { category: 'scope-discipline', verdict: 'pass', detail: 'OK' },
          { category: 'pattern-fit', verdict: 'pass', detail: 'OK' },
        ],
      },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runReviewPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('close');
    expect(output.revision).toBeDefined();
    expect(output.revision!.source).toBe('reviewer');
    expect(output.revision!.failedCategories).toHaveLength(1);
    expect(output.revision!.failedCategories[0].category).toBe('test-sufficiency');
    expect(output.revision!.suggestedFocus).toContain('Missing edge case tests');
  });

  it('soft-fail (pattern-fit) → revision request', async () => {
    const result: AgentResult = {
      ...completedResult,
      rubric: {
        role: 'reviewer',
        categories: [
          { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
          { category: 'test-sufficiency', verdict: 'pass', detail: 'OK' },
          { category: 'scope-discipline', verdict: 'pass', detail: 'OK' },
          { category: 'pattern-fit', verdict: 'fail', detail: 'Does not match existing patterns' },
        ],
      },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runReviewPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('close');
    expect(output.revision).toBeDefined();
    expect(output.revision!.source).toBe('reviewer');
    expect(output.revision!.failedCategories[0].category).toBe('pattern-fit');
  });

  it('both soft-fails → revision with both categories', async () => {
    const result: AgentResult = {
      ...completedResult,
      rubric: {
        role: 'reviewer',
        categories: [
          { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
          { category: 'test-sufficiency', verdict: 'fail', detail: 'Needs more tests' },
          { category: 'scope-discipline', verdict: 'pass', detail: 'OK' },
          { category: 'pattern-fit', verdict: 'fail', detail: 'Wrong pattern' },
        ],
      },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runReviewPhase(makeConfig(), store as any, new Map());

    expect(output.revision).toBeDefined();
    expect(output.revision!.failedCategories).toHaveLength(2);
  });

  it('critical findings + soft-fail rubric → abort (not revision)', async () => {
    const result: AgentResult = {
      ...completedResult,
      findings: { critical: 1, warnings: 0, info: 0, details: [] },
      rubric: {
        role: 'reviewer',
        categories: [
          { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
          { category: 'test-sufficiency', verdict: 'fail', detail: 'Needs tests' },
          { category: 'scope-discipline', verdict: 'pass', detail: 'OK' },
          { category: 'pattern-fit', verdict: 'pass', detail: 'OK' },
        ],
      },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runReviewPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('abort');
    expect(output.revision).toBeUndefined();
  });

  it('critical findings → abort (not revision)', async () => {
    const result: AgentResult = {
      ...completedResult,
      findings: { critical: 1, warnings: 0, info: 0, details: [] },
    };
    mockSpawnAgent.mockResolvedValue({ raw: '', result, durationMs: 100 });

    const store = makeMockStore();
    const output = await runReviewPhase(makeConfig(), store as any, new Map());

    expect(output.nextPhase).toBe('abort');
    expect(output.revision).toBeUndefined();
  });

  it('dry-run → skip, no revision', async () => {
    const store = makeMockStore();
    const output = await runReviewPhase(makeConfig({ dryRun: true }), store as any, new Map());

    expect(output.nextPhase).toBe('close');
    expect(output.revision).toBeUndefined();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});
