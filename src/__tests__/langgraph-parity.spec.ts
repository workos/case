import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  mockSpawnAgent,
  mockRunCommand,
  mockWriteRunMetrics,
  mockGetCurrentPromptVersions,
  mockFindPriorRunId,
  mockGatherSessionContext,
  mockAnalyzeFailure,
} from './setup-mocks.js';
import type { AgentResult, PipelineConfig, TaskJson } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * LangGraph conditional-edge routing oracle (NET-NEW for Phase 1.3, §9). Each
 * case drives the engine over a fixed queue of mock spawn results and pins the
 * resulting `notifier.phaseEnd(phase, …, outcome)` sequence — covering the
 * scout→implement→verify→review→close→retrospective flow plus the revision loop,
 * budget cap, and fingerprint short-circuit. Originally the 1.1 cross-engine
 * parity suite; the legacy executor it compared against was deleted in 1.3, so
 * the pinned expected sequences now stand alone as the routing contract.
 */

// --- Pipeline-specific mocks (mirror pipeline.spec) ---
// Created inside vi.hoisted so the hoisted vi.mock factories below reference them.
const { mockStoreRead, mockStoreSetPendingRevision, MockTaskStore, mockCreateNotifier } = vi.hoisted(() => {
  const mockStoreRead = vi.fn();
  const mockStoreSetPendingRevision = vi.fn();
  const mockStoreWriteFromProjection = vi.fn();
  // Constructor mock must be a real class: under Bun runtime, `new vi.fn()`
  // throws "Reflect.construct requires the first argument be a constructor".
  class MockTaskStore {
    read = mockStoreRead;
    readStatus = vi.fn(() => Promise.resolve('active'));
    setStatus = vi.fn(() => Promise.resolve(undefined));
    setAgentPhase = vi.fn(() => Promise.resolve(undefined));
    setField = vi.fn(() => Promise.resolve(undefined));
    setPendingRevision = mockStoreSetPendingRevision;
    writeFromProjection = mockStoreWriteFromProjection;
  }
  const mockCreateNotifier = vi.fn();
  return {
    mockStoreRead,
    mockStoreSetPendingRevision,
    mockStoreWriteFromProjection,
    MockTaskStore,
    mockCreateNotifier,
  };
});

vi.mock('../state/task-store.js', () => ({ TaskStore: MockTaskStore }));
vi.mock('../notify.js', () => ({
  createNotifier: mockCreateNotifier,
  formatDuration: (ms: number) => `${Math.floor(ms / 1000)}s`,
  defaultAskUser: async (_mode: unknown, _prompt: string, options: string[]) => options[options.length - 1],
}));

const { runPipeline } = await import('../pipeline.js');

const tempCaseRoot = join(process.env.TMPDIR ?? '/tmp', `case-langgraph-parity-${Date.now()}`);

async function setupTempFiles() {
  const agentsDir = join(tempCaseRoot, 'agents');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(join(tempCaseRoot, '.case'), { recursive: true });
  for (const agent of ['scout', 'implementer', 'verifier', 'reviewer', 'closer', 'retrospective']) {
    await Bun.write(join(agentsDir, `${agent}.md`), `# ${agent}`);
  }
}

const mockRuntime = {
  spawn: (options: unknown) => mockSpawnAgent(options),
  createTools: () => [],
  abort: () => {},
};

/** A notifier that records the (phase, outcome) of every phaseEnd. */
function capturingNotifier(seq: string[]) {
  return {
    send: vi.fn(),
    askUser: vi.fn(async (_p: string, options: string[]) => options[options.length - 1]),
    phaseStart: vi.fn(),
    phaseEnd: vi.fn((phase: string, _agent: string, _elapsed: number, outcome: string) => {
      seq.push(`${phase}:${outcome}`);
    }),
    toolStart: vi.fn(),
    toolEnd: vi.fn(),
    stepIndicator: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
  };
}

const mockTask: TaskJson = {
  id: 'cli-1',
  status: 'active',
  created: '2026-03-14T00:00:00Z',
  repo: 'cli',
  agents: {},
  tested: false,
  manualTested: false,
  prUrl: null,
  prNumber: null,
};

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'attended',
    taskId: 'cli-1',
    tdId: 'td-test1',
    repoPath: tempCaseRoot,
    repoName: 'cli',
    packageRoot: tempCaseRoot,
    dataDir: tempCaseRoot,
    maxRetries: 1,
    dryRun: false,
    runtime: mockRuntime as never,
    ...overrides,
  };
}

const completed: AgentResult = {
  status: 'completed',
  summary: 'Done',
  artifacts: {
    commit: 'abc',
    filesChanged: [],
    testsPassed: true,
    screenshotUrls: [],
    evidenceMarkers: [],
    prUrl: null,
    prNumber: null,
  },
  error: null,
};

const prResult: AgentResult = {
  ...completed,
  summary: 'PR created',
  artifacts: { ...completed.artifacts, prUrl: 'https://github.com/workos/cli/pull/42', prNumber: 42 },
};

const verifierFail: AgentResult = {
  ...completed,
  rubric: {
    role: 'verifier',
    categories: [{ category: 'edge-case-checked', verdict: 'fail', detail: 'missing null check' }],
  },
};

const reviewerSoftFail: AgentResult = {
  ...completed,
  rubric: {
    role: 'reviewer',
    categories: [
      { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
      { category: 'test-sufficiency', verdict: 'fail', detail: 'needs tests' },
      { category: 'scope-discipline', verdict: 'pass', detail: 'OK' },
      { category: 'pattern-fit', verdict: 'pass', detail: 'OK' },
    ],
  },
};

const reviewerHardFail: AgentResult = {
  ...completed,
  rubric: {
    role: 'reviewer',
    categories: [
      { category: 'principle-compliance', verdict: 'fail', detail: 'violates golden principle' },
      { category: 'test-sufficiency', verdict: 'pass', detail: 'OK' },
      { category: 'scope-discipline', verdict: 'pass', detail: 'OK' },
      { category: 'pattern-fit', verdict: 'pass', detail: 'OK' },
    ],
  },
};

function agentRaw(result: AgentResult): string {
  return `\n<<<AGENT_RESULT\n${JSON.stringify(result)}\nAGENT_RESULT>>>\n`;
}
function spawn(result: AgentResult) {
  return { raw: agentRaw(result), result, durationMs: 100 };
}
const scoutResult: AgentResult = {
  ...completed,
  summary: 'Scout found 0 relevant files',
  findings: { relevantFiles: [], patterns: [], constraints: [] } as never,
};

type SpawnSpec = ReturnType<typeof spawn>;

/** Run one pipeline through the engine and return the phaseEnd sequence. */
async function runEngine(specs: SpawnSpec[], overrides: Partial<PipelineConfig> = {}): Promise<string[]> {
  mockSpawnAgent.mockReset();
  for (const s of specs) mockSpawnAgent.mockResolvedValueOnce(s);

  const seq: string[] = [];
  const notifier = capturingNotifier(seq);
  await runPipeline(makeConfig({ notifier: notifier as never, ...overrides }));
  return seq;
}

/** Run a case and assert its (phase, outcome) sequence matches `expected`. */
async function assertSequence(
  specs: SpawnSpec[],
  expected: string[],
  overrides: Partial<PipelineConfig> = {},
): Promise<void> {
  const seq = await runEngine(specs, overrides);
  expect(seq).toEqual(expected);
}

describe('LangGraph engine routing (phase-outcome sequences)', () => {
  beforeEach(async () => {
    mockSpawnAgent.mockReset();
    mockRunCommand.mockReset();
    mockWriteRunMetrics.mockReset();
    mockGetCurrentPromptVersions.mockReset();
    mockFindPriorRunId.mockReset();
    mockStoreRead.mockReset();
    mockStoreSetPendingRevision.mockReset();

    mockStoreRead.mockResolvedValue(mockTask);
    mockStoreSetPendingRevision.mockResolvedValue(undefined);
    mockRunCommand.mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });
    mockGatherSessionContext.mockReset();
    mockGatherSessionContext.mockResolvedValue({});
    mockAnalyzeFailure.mockReset();
    mockAnalyzeFailure.mockResolvedValue({
      failureClass: 'unknown',
      failedAgent: 'implementer',
      errorSummary: 'error',
      filesInvolved: [],
      whatWasTried: [],
      suggestedFocus: 'try again',
      retryViable: true,
    });
    mockWriteRunMetrics.mockResolvedValue(undefined);
    mockGetCurrentPromptVersions.mockResolvedValue({});
    mockFindPriorRunId.mockResolvedValue(null);

    await setupTempFiles();
  });

  afterAll(async () => {
    await rm(tempCaseRoot, { recursive: true, force: true });
  });

  it('standard profile happy path', async () => {
    await assertSequence(
      [spawn(scoutResult), spawn(completed), spawn(completed), spawn(completed), spawn(prResult), spawn(completed)],
      [
        'scout:completed',
        'implement:completed',
        'verify:completed',
        'review:completed',
        'close:completed',
        'retrospective:completed',
      ],
    );
  });

  it('tiny profile skips scout + verify', async () => {
    mockStoreRead.mockResolvedValue({ ...mockTask, profile: 'tiny' as const });
    await assertSequence(
      [spawn(completed), spawn(completed), spawn(prResult), spawn(completed)],
      ['implement:completed', 'review:completed', 'close:completed', 'retrospective:completed'],
    );
  });

  it('verifier revision cycle (verify fails once, then clean)', async () => {
    await assertSequence(
      [
        spawn(scoutResult), // scout
        spawn(completed), // implement c0
        spawn(verifierFail), // verify c0 → revision
        spawn(completed), // implement c1
        spawn(completed), // verify c1 clean
        spawn(completed), // review
        spawn(prResult), // close
        spawn(completed), // retrospective
      ],
      [
        'scout:completed',
        'implement:completed',
        'verify:completed',
        'implement:completed',
        'verify:completed',
        'review:completed',
        'close:completed',
        'retrospective:completed',
      ],
    );
  });

  it('reviewer soft-fail revision cycle', async () => {
    await assertSequence(
      [
        spawn(scoutResult), // scout
        spawn(completed), // implement c0
        spawn(completed), // verify c0 clean
        spawn(reviewerSoftFail), // review c0 → revision
        spawn(completed), // implement c1
        spawn(completed), // verify c1
        spawn(completed), // review c1 clean
        spawn(prResult), // close
        spawn(completed), // retrospective
      ],
      [
        'scout:completed',
        'implement:completed',
        'verify:completed',
        'review:completed',
        'implement:completed',
        'verify:completed',
        'review:completed',
        'close:completed',
        'retrospective:completed',
      ],
    );
  });

  it('reviewer hard-fail aborts (no revision)', async () => {
    // Hard-gate categories (principle-compliance, scope-discipline) are
    // golden-principle violations: terminal, not revisable. The engine must
    // route straight to retrospective — no revision cycle, no close. Regression
    // guard for the reviewer-treadmill loop, where a hard fail was spun as a
    // soft revision until the budget/crash ended it.
    await assertSequence(
      [
        spawn(scoutResult), // scout
        spawn(completed), // implement c0
        spawn(completed), // verify c0 clean
        spawn(reviewerHardFail), // review c0 hard-fail → abort
        spawn(completed), // retrospective
      ],
      ['scout:completed', 'implement:completed', 'verify:completed', 'review:completed', 'retrospective:completed'],
    );
  });

  it('revision budget exhausted (maxRevisionCycles=1)', async () => {
    await assertSequence(
      [
        spawn(scoutResult), // scout
        spawn(completed), // implement c0
        spawn(verifierFail), // verify c0 → revision (cycle 1)
        spawn(completed), // implement c1
        spawn(completed), // verify c1 clean
        spawn(reviewerSoftFail), // review c1 soft-fail → budget exhausted → close
        spawn(prResult), // close
        spawn(completed), // retrospective
      ],
      [
        'scout:completed',
        'implement:completed',
        'verify:completed',
        'implement:completed',
        'verify:completed',
        'review:completed',
        'close:completed',
        'retrospective:completed',
      ],
      { maxRevisionCycles: 1 },
    );
  });

  it('fingerprint short-circuit (identical failure two cycles running)', async () => {
    await assertSequence(
      [
        spawn(scoutResult), // scout
        spawn(completed), // implement c0
        spawn(verifierFail), // verify c0 fail → revision (cycle 1)
        spawn(completed), // implement c1
        spawn(verifierFail), // verify c1 same failure → fingerprint match → revision denied
        spawn(completed), // review c1 (trailing review still runs, can't re-revise)
        spawn(prResult), // close
        spawn(completed), // retrospective
      ],
      [
        'scout:completed',
        'implement:completed',
        'verify:completed',
        'implement:completed',
        'verify:completed',
        'review:completed',
        'close:completed',
        'retrospective:completed',
      ],
    );
  });
});
