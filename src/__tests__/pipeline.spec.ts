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
const mockStoreSetStatus = mock();
const mockStoreSetAgentPhase = mock();
const mockStoreSetField = mock();
const MockTaskStore = mock(() => ({
  read: mockStoreRead,
  readStatus: mock(),
  setStatus: mockStoreSetStatus,
  setAgentPhase: mockStoreSetAgentPhase,
  setField: mockStoreSetField,
}));

const mockNotifierSend = mock();
const mockNotifierAskUser = mock();
const mockCreateNotifier = mock(() => ({
  send: mockNotifierSend,
  askUser: mockNotifierAskUser,
}));

mock.module('../state/task-store.js', () => ({ TaskStore: MockTaskStore }));
mock.module('../notify.js', () => ({ createNotifier: mockCreateNotifier }));

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
    mockStoreSetStatus.mockReset();
    mockStoreSetAgentPhase.mockReset();
    mockStoreSetField.mockReset();
    mockNotifierSend.mockReset();
    mockNotifierAskUser.mockReset();

    // Defaults
    mockStoreRead.mockResolvedValue(mockTask);
    mockStoreSetStatus.mockResolvedValue(undefined);
    mockStoreSetAgentPhase.mockResolvedValue(undefined);
    mockStoreSetField.mockResolvedValue(undefined);
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
    // Also check legacy log-run.sh was called
    const runScriptCalls = mockRunScript.mock.calls;
    const logRunCall = runScriptCalls.find(
      (call: any[]) => Array.isArray(call[1]) && call[1].some((arg: string) => arg.includes('log-run.sh')),
    );
    expect(logRunCall).toBeDefined();
  });
});
