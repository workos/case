import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import {
  mockSpawnAgent,
  mockRunCommand,
  mockWriteRunMetrics,
  mockGetCurrentPromptVersions,
  mockFindPriorRunId,
  mockGatherSessionContext,
  mockAnalyzeFailure,
} from './mocks.js';
import type { AgentResult, PipelineConfig, TaskJson } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Phase 1.1 acceptance: a run through the LangGraph engine (`CASE_ENGINE=langgraph`)
 * produces the *same phase outcomes* as the legacy DAG executor, over an identical
 * mock runtime. Each case runs both engines against the same queued spawn results
 * and asserts the `notifier.phaseEnd(phase, …, outcome)` sequence matches — and
 * matches an explicit expected sequence (so the parity is pinned, not just mutual).
 */

// --- Pipeline-specific mocks (mirror pipeline.spec) ---
const mockStoreRead = mock();
const mockStoreSetPendingRevision = mock();
const mockStoreWriteFromProjection = mock();
const MockTaskStore = mock(() => ({
  read: mockStoreRead,
  readStatus: mock(() => Promise.resolve('active')),
  setStatus: mock(() => Promise.resolve(undefined)),
  setAgentPhase: mock(() => Promise.resolve(undefined)),
  setField: mock(() => Promise.resolve(undefined)),
  setPendingRevision: mockStoreSetPendingRevision,
  writeFromProjection: mockStoreWriteFromProjection,
}));

mock.module('../state/task-store.js', () => ({ TaskStore: MockTaskStore }));
mock.module('../notify.js', () => ({
  createNotifier: mock(),
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
    send: mock(),
    askUser: mock(async (_p: string, options: string[]) => options[options.length - 1]),
    phaseStart: mock(),
    phaseEnd: mock((phase: string, _agent: string, _elapsed: number, outcome: string) => {
      seq.push(`${phase}:${outcome}`);
    }),
    toolStart: mock(),
    toolEnd: mock(),
    stepIndicator: mock(),
    startHeartbeat: mock(),
    stopHeartbeat: mock(),
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

/** Run one pipeline through the chosen engine and return the phaseEnd sequence. */
async function runEngine(
  engine: 'legacy' | 'langgraph',
  specs: SpawnSpec[],
  overrides: Partial<PipelineConfig> = {},
): Promise<string[]> {
  mockSpawnAgent.mockReset();
  for (const s of specs) mockSpawnAgent.mockResolvedValueOnce(s);

  const seq: string[] = [];
  const notifier = capturingNotifier(seq);

  const prev = process.env.CASE_ENGINE;
  if (engine === 'langgraph') process.env.CASE_ENGINE = 'langgraph';
  else delete process.env.CASE_ENGINE;
  try {
    await runPipeline(makeConfig({ notifier: notifier as never, ...overrides }));
  } finally {
    if (prev === undefined) delete process.env.CASE_ENGINE;
    else process.env.CASE_ENGINE = prev;
  }
  return seq;
}

/** Run a case through both engines, assert they match each other and `expected`. */
async function assertParity(
  specs: SpawnSpec[],
  expected: string[],
  overrides: Partial<PipelineConfig> = {},
): Promise<void> {
  const legacy = await runEngine('legacy', specs, overrides);
  const langgraph = await runEngine('langgraph', specs, overrides);
  expect(legacy).toEqual(expected);
  expect(langgraph).toEqual(expected);
}

describe('LangGraph ↔ legacy executor parity', () => {
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
    await assertParity(
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
    await assertParity(
      [spawn(completed), spawn(completed), spawn(prResult), spawn(completed)],
      ['implement:completed', 'review:completed', 'close:completed', 'retrospective:completed'],
    );
  });

  it('verifier revision cycle (verify fails once, then clean)', async () => {
    await assertParity(
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
    await assertParity(
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

  it('revision budget exhausted (maxRevisionCycles=1)', async () => {
    await assertParity(
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
    await assertParity(
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
