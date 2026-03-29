import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import {
  mockSpawnAgent,
  mockRunScript,
  mockWriteRunMetrics,
  mockGetCurrentPromptVersions,
  mockFindPriorRunId,
} from './mocks.js';
import type { AgentResult, PipelineConfig, TaskJson } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Pipeline-specific mocks (not shared — only pipeline uses these)
const mockStoreRead = mock();
const mockStoreReadStatus = mock();
const mockStoreSetStatus = mock();
const mockStoreSetAgentPhase = mock();
const mockStoreSetField = mock();
const mockStoreSetPendingRevision = mock();
const MockTaskStore = mock(() => ({
  read: mockStoreRead,
  readStatus: mockStoreReadStatus,
  setStatus: mockStoreSetStatus,
  setAgentPhase: mockStoreSetAgentPhase,
  setField: mockStoreSetField,
  setPendingRevision: mockStoreSetPendingRevision,
}));

const mockNotifierSend = mock();
const mockNotifierAskUser = mock();
const mockNotifierPhaseStart = mock();
const mockNotifierPhaseEnd = mock();
const mockCreateNotifier = mock(() => ({
  send: mockNotifierSend,
  askUser: mockNotifierAskUser,
  phaseStart: mockNotifierPhaseStart,
  phaseEnd: mockNotifierPhaseEnd,
}));

mock.module('../state/task-store.js', () => ({ TaskStore: MockTaskStore }));
mock.module('../notify.js', () => ({
  createNotifier: mockCreateNotifier,
  formatDuration: (ms: number) => `${Math.floor(ms / 1000)}s`,
}));

const { runPipeline } = await import('../pipeline.js');

// Temp directory for agent templates (real assembler reads these)
const tempCaseRoot = join(process.env.TMPDIR ?? '/tmp', `case-pipeline-test-${Date.now()}`);

async function setupTempFiles() {
  const agentsDir = join(tempCaseRoot, 'agents');
  const docsDir = join(tempCaseRoot, 'docs/learnings');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });
  for (const agent of ['implementer', 'verifier', 'reviewer', 'closer', 'retrospective']) {
    await Bun.write(join(agentsDir, `${agent}.md`), `# ${agent}`);
  }
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

const completedAgentOutput: AgentResult = {
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

const prAgentOutput: AgentResult = {
  ...completedAgentOutput,
  summary: 'PR created',
  artifacts: { ...completedAgentOutput.artifacts, prUrl: 'https://github.com/workos/cli/pull/42', prNumber: 42 },
};

const failedAgentOutput: AgentResult = {
  status: 'failed',
  summary: 'Failed',
  artifacts: {
    commit: null,
    filesChanged: [],
    testsPassed: false,
    screenshotUrls: [],
    evidenceMarkers: [],
    prUrl: null,
    prNumber: null,
  },
  error: 'Something went wrong',
};

/** Build a fake AGENT_RESULT raw string that parseAgentResult can extract */
function agentRaw(result: AgentResult): string {
  return `\n<<<AGENT_RESULT\n${JSON.stringify(result)}\nAGENT_RESULT>>>\n`;
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

describe('runPipeline', () => {
  beforeEach(async () => {
    // Reset all shared mocks
    mockSpawnAgent.mockReset();
    mockRunScript.mockReset();
    mockWriteRunMetrics.mockReset();
    mockGetCurrentPromptVersions.mockReset();
    mockFindPriorRunId.mockReset();

    // Reset pipeline-specific mocks
    mockStoreRead.mockReset();
    mockStoreReadStatus.mockReset();
    mockStoreSetStatus.mockReset();
    mockStoreSetAgentPhase.mockReset();
    mockStoreSetField.mockReset();
    mockStoreSetPendingRevision.mockReset();
    mockNotifierSend.mockReset();
    mockNotifierAskUser.mockReset();

    // Defaults — track status so walkStatusToPhase can read the current value
    let currentStatus = 'active';
    mockStoreRead.mockResolvedValue(mockTask);
    mockStoreReadStatus.mockImplementation(() => Promise.resolve(currentStatus));
    mockStoreSetStatus.mockImplementation((s: string) => { currentStatus = s; return Promise.resolve(undefined); });
    mockStoreSetAgentPhase.mockResolvedValue(undefined);
    mockStoreSetField.mockResolvedValue(undefined);
    mockStoreSetPendingRevision.mockResolvedValue(undefined);
    mockRunScript.mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });
    mockWriteRunMetrics.mockResolvedValue(undefined);
    mockGetCurrentPromptVersions.mockResolvedValue({});
    mockFindPriorRunId.mockResolvedValue(null);

    await setupTempFiles();
  });

  afterAll(async () => {
    await rm(tempCaseRoot, { recursive: true, force: true });
  });

  it('happy path: all phases complete successfully', async () => {
    // Each spawnAgent call returns a different AGENT_RESULT for each phase
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // 5 agent spawns: implementer, verifier, reviewer, closer, retrospective
    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('PR created'));
    expect(mockNotifierSend).toHaveBeenCalledWith('Pipeline completed successfully.');
    expect(mockWriteRunMetrics).toHaveBeenCalled();
  });

  it('implement failure -> user aborts -> retrospective runs', async () => {
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(failedAgentOutput), result: failedAgentOutput, durationMs: 100 }) // implementer fails
      .mockResolvedValueOnce({ raw: agentRaw(failedAgentOutput), result: failedAgentOutput, durationMs: 100 }) // retry also fails
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    // analyze-failure.sh says not retryable
    mockRunScript
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // session-start
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git log
      .mockResolvedValueOnce({
        // analyze-failure
        stdout: JSON.stringify({
          failureClass: 'unknown',
          retryViable: false,
          errorSummary: 'bad',
          filesInvolved: [],
          whatWasTried: [],
          suggestedFocus: 'stop',
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 }); // any remaining

    mockNotifierAskUser.mockResolvedValue('Abort');

    await runPipeline(makeConfig());

    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('unattended mode auto-aborts on failure', async () => {
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(failedAgentOutput), result: failedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 });

    mockRunScript
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          failureClass: 'unknown',
          retryViable: false,
          errorSummary: 'bad',
          filesInvolved: [],
          whatWasTried: [],
          suggestedFocus: 'stop',
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });

    // Unattended notifier auto-selects last option ("Abort")
    mockNotifierAskUser.mockResolvedValue('Abort');

    await runPipeline(makeConfig({ mode: 'unattended' }));

    // Should still run retrospective
    expect(mockSpawnAgent).toHaveBeenCalledTimes(2); // implementer + retrospective
  });

  it('re-entry from verifying status skips implement phase', async () => {
    const verifyingTask = {
      ...mockTask,
      status: 'verifying' as const,
      agents: { verifier: { started: null, completed: null, status: 'running' as const } },
    };
    mockStoreRead.mockResolvedValue(verifyingTask);

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // 4 agents: verifier, reviewer, closer, retrospective (no implementer)
    expect(mockSpawnAgent).toHaveBeenCalledTimes(4);
    // First spawn should be verifier, not implementer — check the prompt contains verifier template
    const firstPrompt = mockSpawnAgent.mock.calls[0][0].prompt;
    expect(firstPrompt).toContain('# verifier');
  });

  it('dry-run mode passes all phases without spawning agents', async () => {
    await runPipeline(makeConfig({ dryRun: true }));

    // No agents spawned in dry-run
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(mockNotifierSend).toHaveBeenCalledWith('Pipeline completed successfully.');
  });

  it('metrics are written at the end', async () => {
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 });

    await runPipeline(makeConfig());

    expect(mockWriteRunMetrics).toHaveBeenCalledTimes(1);
  });

  it('verifier rubric fail triggers revision loop back to implement', async () => {
    const verifierWithFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'reproduced-scenario', verdict: 'pass', detail: 'OK' },
          { category: 'edge-case-checked', verdict: 'fail', detail: 'Missing null check' },
        ],
      },
    };
    const verifierClean: AgentResult = { ...completedAgentOutput };

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (initial)
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (finds issue)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision)
      .mockResolvedValueOnce({ raw: agentRaw(verifierClean), result: verifierClean, durationMs: 100 }) // verifier (clean)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // 7 spawns: impl, verify(fail), impl(revision), verify(pass), review, close, retro
    expect(mockSpawnAgent).toHaveBeenCalledTimes(7);
    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('Revision cycle 1'));
    expect(mockNotifierSend).toHaveBeenCalledWith('Pipeline completed successfully.');
  });

  it('revision budget exhausted → proceeds with warnings', async () => {
    const verifierWithFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'edge-case-checked', verdict: 'fail', detail: 'Still failing' },
        ],
      },
    };

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (initial)
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (cycle 1 trigger)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision 1)
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (cycle 2 trigger)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision 2)
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (budget exhausted → proceed)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('Revision budget exhausted'));
    expect(mockNotifierSend).toHaveBeenCalledWith('Pipeline completed successfully.');
  });

  it('reviewer soft-fail triggers revision loop', async () => {
    const reviewerSoftFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'reviewer',
        categories: [
          { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
          { category: 'test-sufficiency', verdict: 'fail', detail: 'Needs more tests' },
          { category: 'scope-discipline', verdict: 'pass', detail: 'OK' },
          { category: 'pattern-fit', verdict: 'pass', detail: 'OK' },
        ],
      },
    };

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(reviewerSoftFail), result: reviewerSoftFail, durationMs: 100 }) // reviewer (soft fail)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier (re-verify)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer (clean)
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    expect(mockSpawnAgent).toHaveBeenCalledTimes(8);
    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('Revision cycle 1: reviewer'));
  });

  it('maxRevisionCycles=0 disables revision loop', async () => {
    const verifierWithFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'edge-case-checked', verdict: 'fail', detail: 'Failing' },
        ],
      },
    };

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (has fails but budget=0)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig({ maxRevisionCycles: 0 }));

    // No revision — straight through: impl, verify, review, close, retro
    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('Revision budget exhausted'));
  });

  it('revision context is passed to implementer on re-entry', async () => {
    const verifierWithFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'edge-case-checked', verdict: 'fail', detail: 'Missing null check' },
        ],
      },
    };

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (initial)
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (fail)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier (clean)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // Second implementer call (index 2) should have REVISION CONTEXT in prompt
    const revisionPrompt = mockSpawnAgent.mock.calls[2][0].prompt;
    expect(revisionPrompt).toContain('REVISION CONTEXT');
    expect(revisionPrompt).toContain('edge-case-checked');
    expect(revisionPrompt).toContain('Missing null check');

    // First implementer call (index 0) should NOT have revision context
    const initialPrompt = mockSpawnAgent.mock.calls[0][0].prompt;
    expect(initialPrompt).not.toContain('REVISION CONTEXT');
  });

  it('implementer failure during revision triggers retry inside the revision', async () => {
    const verifierWithFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'edge-case-checked', verdict: 'fail', detail: 'Missing check' },
        ],
      },
    };

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (initial)
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (triggers revision)
      .mockResolvedValueOnce({ raw: agentRaw(failedAgentOutput), result: failedAgentOutput, durationMs: 100 }) // implementer (revision attempt 1 — fails)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (retry within revision — succeeds)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier (clean)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    // runScript calls: prefetchRepoContext (2 calls per phase) + analyze-failure
    // Order: impl(2), verify(2), revision-impl(2), analyze-failure(1), remaining
    mockRunScript
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // session-start (initial impl)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git log (initial impl)
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // session-start (verifier)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git log (verifier)
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // session-start (revision impl)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git log (revision impl)
      .mockResolvedValueOnce({
        // analyze-failure (revision implementer failed)
        stdout: JSON.stringify({
          failureClass: 'test-failure',
          failedAgent: 'implementer',
          errorSummary: 'Tests failed during revision',
          filesInvolved: [],
          whatWasTried: ['revision approach'],
          suggestedFocus: 'Fix the test',
          retryViable: true,
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 }); // remaining runScript calls

    await runPipeline(makeConfig());

    // 8 spawns: impl, verify(fail), impl(revision-fails), impl(retry-succeeds), verify(clean), review, close, retro
    expect(mockSpawnAgent).toHaveBeenCalledTimes(8);
    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('Revision cycle 1'));
    expect(mockNotifierSend).toHaveBeenCalledWith('Pipeline completed successfully.');

    // The retry prompt should contain RETRY CONTEXT (not REVISION CONTEXT)
    const retryCall = mockSpawnAgent.mock.calls[3]; // 4th spawn = retry within revision
    expect(retryCall[0].prompt).toContain('RETRY CONTEXT');
  });

  it('multiple revision cycles use latest context only (no accumulation)', async () => {
    const verifierFail1: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'edge-case-checked', verdict: 'fail', detail: 'First issue: missing null check' },
        ],
      },
    };
    const verifierFail2: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'evidence-proves-change', verdict: 'fail', detail: 'Second issue: no screenshot' },
        ],
      },
    };

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (initial)
      .mockResolvedValueOnce({ raw: agentRaw(verifierFail1), result: verifierFail1, durationMs: 100 }) // verifier (cycle 1)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision 1)
      .mockResolvedValueOnce({ raw: agentRaw(verifierFail2), result: verifierFail2, durationMs: 100 }) // verifier (cycle 2)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision 2)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier (clean)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // Revision 2 implementer (index 4) should have cycle 2 context, not cycle 1
    const revision2Prompt = mockSpawnAgent.mock.calls[4][0].prompt;
    expect(revision2Prompt).toContain('cycle 2');
    expect(revision2Prompt).toContain('Second issue: no screenshot');
    // Should NOT contain cycle 1's issue (context replaced, not accumulated)
    expect(revision2Prompt).not.toContain('First issue: missing null check');
  });

  it('shared revision counter across verify and review', async () => {
    const verifierWithFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [{ category: 'edge-case-checked', verdict: 'fail', detail: 'Issue' }],
      },
    };
    const reviewerSoftFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'reviewer',
        categories: [
          { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
          { category: 'test-sufficiency', verdict: 'fail', detail: 'Needs tests' },
          { category: 'scope-discipline', verdict: 'pass', detail: 'OK' },
        ],
      },
    };

    // maxRevisionCycles=1: verify uses the one cycle, reviewer can't use any
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (uses cycle 1)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier (clean)
      .mockResolvedValueOnce({ raw: agentRaw(reviewerSoftFail), result: reviewerSoftFail, durationMs: 100 }) // reviewer (soft fail, budget exhausted)
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig({ maxRevisionCycles: 1 }));

    // Verify used cycle 1. Reviewer finds soft fail but budget exhausted → proceeds to close.
    expect(mockSpawnAgent).toHaveBeenCalledTimes(7);
    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('Revision cycle 1: verifier'));
    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('Revision budget exhausted'));
  });

  it('tiny profile skips verify phase', async () => {
    const tinyTask = { ...mockTask, profile: 'tiny' as const };
    mockStoreRead.mockResolvedValue(tinyTask);

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer (verify skipped)
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // 4 agents: implementer, reviewer, closer, retrospective (no verifier)
    expect(mockSpawnAgent).toHaveBeenCalledTimes(4);
    // Second spawn should be reviewer, not verifier
    const secondPrompt = mockSpawnAgent.mock.calls[1][0].prompt;
    expect(secondPrompt).toContain('# reviewer');
    // walkStatusToPhase should walk implementing → verifying → reviewing
    const statusCalls = mockStoreSetStatus.mock.calls.map((c: any) => c[0]);
    expect(statusCalls).toContain('verifying');
    expect(statusCalls).toContain('reviewing');
  });

  it('reviewer revision walks status reviewing → verifying → implementing', async () => {
    const reviewerSoftFail: AgentResult = {
      ...completedAgentOutput,
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

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(reviewerSoftFail), result: reviewerSoftFail, durationMs: 100 }) // reviewer (soft fail)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer (clean)
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // Verify the revision loop fired (8 spawns, not 5)
    expect(mockSpawnAgent).toHaveBeenCalledTimes(8);
    // walkStatusToPhase should walk through intermediate statuses.
    // The full status sequence should include verifying and implementing after the first reviewing.
    const statusCalls = mockStoreSetStatus.mock.calls.map((c: any) => c[0]);
    // After the first review (soft-fail), the pipeline walks reviewing → verifying → implementing
    const firstReviewIdx = statusCalls.indexOf('reviewing');
    const afterFirstReview = statusCalls.slice(firstReviewIdx + 1);
    expect(afterFirstReview).toContain('verifying');
    expect(afterFirstReview).toContain('implementing');
  });

  it('standard profile runs all phases (backward compat)', async () => {
    const standardTask = { ...mockTask, profile: 'standard' as const };
    mockStoreRead.mockResolvedValue(standardTask);

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 });

    await runPipeline(makeConfig());

    // 5 agents: all phases
    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
  });

  it('task without profile field defaults to standard (all phases)', async () => {
    // mockTask has no profile field — should default to standard
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 });

    await runPipeline(makeConfig());

    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
  });

  it('revision request is persisted to task store', async () => {
    const verifierWithFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'edge-case-checked', verdict: 'fail', detail: 'Missing null check' },
        ],
      },
    };

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (fail)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier (clean)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // Revision should be persisted when set, and cleared when implementer succeeds
    const persistCalls = mockStoreSetPendingRevision.mock.calls;
    expect(persistCalls.length).toBeGreaterThanOrEqual(2);
    // Find the persist call (non-null argument with source)
    const setCalls = persistCalls.filter((c: any) => c[0] !== null);
    expect(setCalls.length).toBeGreaterThanOrEqual(1);
    expect(setCalls[0][0].source).toBe('verifier');
    // Last call: clear after successful revision implementer
    expect(persistCalls[persistCalls.length - 1][0]).toBeNull();
  });

  it('failed implementer retains pendingRevision for retry', async () => {
    const verifierWithFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [
          { category: 'edge-case-checked', verdict: 'fail', detail: 'Missing check' },
        ],
      },
    };

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (initial)
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (triggers revision)
      .mockResolvedValueOnce({ raw: agentRaw(failedAgentOutput), result: failedAgentOutput, durationMs: 100 }) // implementer (revision — fails)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (retry — succeeds)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier (clean)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    mockRunScript
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          failureClass: 'test-failure',
          retryViable: true,
          errorSummary: 'Tests failed',
          filesInvolved: [],
          whatWasTried: [],
          suggestedFocus: 'Fix test',
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });

    await runPipeline(makeConfig());

    // The retry (4th spawn, index 3) should still have REVISION CONTEXT
    const retryPrompt = mockSpawnAgent.mock.calls[3][0].prompt;
    expect(retryPrompt).toContain('REVISION CONTEXT');
    expect(retryPrompt).toContain('edge-case-checked');
  });

  it('resume from persisted pendingRevision enters implement phase', async () => {
    const taskWithRevision = {
      ...mockTask,
      status: 'verifying' as const,
      agents: { verifier: { started: '2026-03-14', completed: '2026-03-14', status: 'completed' as const } },
      pendingRevision: {
        source: 'verifier' as const,
        failedCategories: [{ category: 'edge-case-checked', verdict: 'fail' as const, detail: 'Missing check' }],
        summary: 'Verifier found 1 issue(s)',
        suggestedFocus: ['Missing check'],
        cycle: 1,
      },
    };
    mockStoreRead.mockResolvedValue(taskWithRevision);

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // Should start at implement (not review), with revision context
    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
    const firstPrompt = mockSpawnAgent.mock.calls[0][0].prompt;
    expect(firstPrompt).toContain('REVISION CONTEXT');
    expect(firstPrompt).toContain('edge-case-checked');
  });

  it('resumed run respects persisted cycle count toward revision budget', async () => {
    // Task already used 1 of 1 revision cycle before crash
    const verifierWithFail: AgentResult = {
      ...completedAgentOutput,
      rubric: {
        role: 'verifier',
        categories: [{ category: 'edge-case-checked', verdict: 'fail', detail: 'Still failing' }],
      },
    };
    const taskWithRevision = {
      ...mockTask,
      status: 'verifying' as const,
      agents: { verifier: { started: '2026-03-14', completed: '2026-03-14', status: 'completed' as const } },
      pendingRevision: {
        source: 'verifier' as const,
        failedCategories: [{ category: 'edge-case-checked', verdict: 'fail' as const, detail: 'Missing check' }],
        summary: 'Verifier found 1 issue(s)',
        suggestedFocus: ['Missing check'],
        cycle: 1,
      },
    };
    mockStoreRead.mockResolvedValue(taskWithRevision);

    // maxRevisionCycles=1: the persisted cycle=1 means the budget is already used.
    // After implementer succeeds, the verifier fails again → budget exhausted (not a fresh cycle 1).
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision)
      .mockResolvedValueOnce({ raw: agentRaw(verifierWithFail), result: verifierWithFail, durationMs: 100 }) // verifier (fails again, budget exhausted)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig({ maxRevisionCycles: 1 }));

    // Should NOT loop back to implement — budget was already exhausted
    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('Revision budget exhausted'));
  });

  it('resumed run writes restored revisionCycles to metrics', async () => {
    const taskWithRevision = {
      ...mockTask,
      status: 'verifying' as const,
      agents: { verifier: { started: '2026-03-14', completed: '2026-03-14', status: 'completed' as const } },
      pendingRevision: {
        source: 'verifier' as const,
        failedCategories: [{ category: 'edge-case-checked', verdict: 'fail' as const, detail: 'Missing check' }],
        summary: 'Verifier found 1 issue(s)',
        suggestedFocus: ['Missing check'],
        cycle: 1,
      },
    };
    mockStoreRead.mockResolvedValue(taskWithRevision);

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer (revision)
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    const writtenMetrics = mockWriteRunMetrics.mock.calls[0][3];
    expect(writtenMetrics.revisionCycles).toBe(1);
  });

  it('complex profile runs all phases (same as standard)', async () => {
    const complexTask = { ...mockTask, profile: 'complex' as const };
    mockStoreRead.mockResolvedValue(complexTask);

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 })
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 });

    await runPipeline(makeConfig());

    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
  });

  it('tiny profile: retrospective still runs after all profiles', async () => {
    const tinyTask = { ...mockTask, profile: 'tiny' as const };
    mockStoreRead.mockResolvedValue(tinyTask);

    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig());

    // Last spawn is retrospective
    const lastCall = mockSpawnAgent.mock.calls[3][0];
    expect(lastCall.agentName).toBe('retrospective');
  });

  // --- Approve gate tests ---

  it('approve phase is skipped when config.approve is false (default)', async () => {
    // Standard happy path — approve phase should be invisible
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig({ approve: false }));

    // 5 agents, no approval prompt
    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
    expect(mockNotifierAskUser).not.toHaveBeenCalledWith('Approve this work?', expect.anything());
  });

  it('approve phase is skipped in unattended mode even with approve: true', async () => {
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    await runPipeline(makeConfig({ approve: true, mode: 'unattended' }));

    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
    expect(mockNotifierAskUser).not.toHaveBeenCalledWith('Approve this work?', expect.anything());
  });

  it('approve: true in attended mode → user approves → proceeds to close', async () => {
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: agentRaw(prAgentOutput), result: prAgentOutput, durationMs: 100 }) // closer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    mockNotifierAskUser.mockResolvedValueOnce('Approve');

    await runPipeline(makeConfig({ approve: true }));

    expect(mockSpawnAgent).toHaveBeenCalledTimes(5);
    expect(mockNotifierAskUser).toHaveBeenCalledWith('Approve this work?', ['Approve', 'Request Changes', 'Reject']);
    expect(mockNotifierSend).toHaveBeenCalledWith('Pipeline completed successfully.');
  });

  it('approve: true → user rejects → abort → retrospective', async () => {
    mockSpawnAgent
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // implementer
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // verifier
      .mockResolvedValueOnce({ raw: agentRaw(completedAgentOutput), result: completedAgentOutput, durationMs: 100 }) // reviewer
      .mockResolvedValueOnce({ raw: '', result: completedAgentOutput, durationMs: 100 }); // retrospective

    mockNotifierAskUser.mockResolvedValueOnce('Reject');

    await runPipeline(makeConfig({ approve: true }));

    // No closer spawned — aborted at approve
    expect(mockSpawnAgent).toHaveBeenCalledTimes(4);
    expect(mockNotifierSend).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('dry-run skips approve phase', async () => {
    await runPipeline(makeConfig({ dryRun: true, approve: true }));

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(mockNotifierSend).toHaveBeenCalledWith('Pipeline completed successfully.');
  });
});
