import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { mockSpawnAgent, mockRunCommand } from './mocks.js';
import type { TaskJson } from '../types.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// --- Mock dependencies ---

const mockDetectRepo = mock();
mock.module('../entry/repo-detector.js', () => ({ detectRepo: mockDetectRepo }));

const mockDetectArgumentType = mock();
const mockFetchIssue = mock();
mock.module('../entry/issue-fetcher.js', () => ({
  detectArgumentType: mockDetectArgumentType,
  fetchIssue: mockFetchIssue,
}));

const mockCreateTask = mock();
mock.module('../entry/task-factory.js', () => ({ createTask: mockCreateTask }));

const mockBuildPipelineConfig = mock();
mock.module('../config.js', () => ({
  buildPipelineConfig: mockBuildPipelineConfig,
  loadProjects: mock(),
  resolveRepoPath: mock(),
}));

const mockRunPipeline = mock();
mock.module('../pipeline.js', () => ({ runPipeline: mockRunPipeline }));

const mockRunBootstrap = mock();
mock.module('../commands/bootstrap.js', () => ({ runBootstrap: mockRunBootstrap }));

// We need to mock findTaskByIssue and findTaskByMarker
const mockFindTaskByIssue = mock();
const mockFindTaskByMarker = mock();
mock.module('../entry/task-scanner.js', () => ({
  findTaskByIssue: mockFindTaskByIssue,
  findTaskByMarker: mockFindTaskByMarker,
}));

const { runCliOrchestrator } = await import('../entry/cli-orchestrator.js');

let tempDir: string;

function taskPath(stem: string, ext: 'task.json' | 'md'): string {
  return join(tempDir, 'repo', '.case', 'tasks', 'active', `${stem}.${ext}`);
}

function makeTaskJson(overrides: Partial<TaskJson> = {}): TaskJson {
  return {
    id: 'cli-abc-fix-test',
    status: 'active',
    created: '2026-03-14T00:00:00Z',
    repo: 'cli',
    issue: '1523',
    issueType: 'github',
    branch: 'fix/issue-1523',
    agents: {},
    tested: false,
    manualTested: false,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

const defaultProject = {
  name: 'cli',
  path: '../cli',
  remote: 'https://github.com/workos/cli.git',
  language: 'typescript',
  packageManager: 'bun',
  commands: {},
};

describe('runCliOrchestrator — re-entry', () => {
  beforeEach(async () => {
    tempDir = join(process.env.TMPDIR ?? '/tmp', `case-orch-test-${Date.now()}`);
    await mkdir(join(tempDir, 'repo', '.case/tasks/active'), { recursive: true });

    // Reset all mocks
    mockDetectRepo.mockReset();
    mockDetectArgumentType.mockReset();
    mockFetchIssue.mockReset();
    mockCreateTask.mockReset();
    mockBuildPipelineConfig.mockReset();
    mockRunPipeline.mockReset();
    mockRunBootstrap.mockReset();
    mockRunCommand.mockReset();
    mockSpawnAgent.mockReset();
    mockFindTaskByIssue.mockReset();
    mockFindTaskByMarker.mockReset();

    // Default: detectRepo succeeds
    mockDetectRepo.mockResolvedValue({
      name: 'cli',
      path: join(tempDir, 'repo'),
      project: defaultProject,
    });

    // Default: pipeline config build succeeds
    mockBuildPipelineConfig.mockResolvedValue({
      mode: 'attended',
      taskJsonPath: taskPath('cli-abc-fix-test', 'task.json'),
      taskMdPath: taskPath('cli-abc-fix-test', 'md'),
      repoPath: join(tempDir, 'repo'),
      repoName: 'cli',
      packageRoot: tempDir,
      dataDir: join(tempDir, 'repo'),
      maxRetries: 1,
      dryRun: false,
    });

    mockRunPipeline.mockResolvedValue(undefined);
    mockRunBootstrap.mockResolvedValue({ ok: true, steps: [], totalDurationMs: 0 });
  });

  it('resumes from existing task when findTaskByIssue matches', async () => {
    // No branch field = skip branch checkout (avoid git dependency in tests)
    const task = makeTaskJson({
      status: 'implementing',
      branch: undefined,
      agents: {
        implementer: { started: '2026-03-14T00:00:00Z', completed: '2026-03-14T00:01:00Z', status: 'completed' },
      },
    });

    mockDetectArgumentType.mockReturnValue('github');
    mockFindTaskByIssue.mockResolvedValue({
      taskJson: task,
      taskJsonPath: taskPath('cli-abc-fix-test', 'task.json'),
      taskMdPath: taskPath('cli-abc-fix-test', 'md'),
      entryPhase: 'verify',
    });

    await runCliOrchestrator({
      argument: '1523',
      mode: 'attended',
      dryRun: false,
      caseRoot: tempDir,
    });

    // Should have called findTaskByIssue
    expect(mockFindTaskByIssue).toHaveBeenCalledWith(tempDir, 'cli', 'github', '1523', expect.stringContaining('repo'));
    // Should NOT have called fetchIssue or createTask (no new task creation)
    expect(mockFetchIssue).not.toHaveBeenCalled();
    expect(mockCreateTask).not.toHaveBeenCalled();
    // Should dispatch to pipeline
    expect(mockRunPipeline).toHaveBeenCalled();
  });

  it('creates new task when findTaskByIssue returns null (mocked branch)', async () => {
    mockDetectArgumentType.mockReturnValue('github');
    mockFindTaskByIssue.mockResolvedValue(null);
    mockFetchIssue.mockResolvedValue({
      title: 'Fix login bug',
      body: 'Login is broken',
      labels: [],
      issueType: 'github',
      issueNumber: '9999',
    });
    mockCreateTask.mockResolvedValue({
      taskId: 'cli-new-task',
      taskJsonPath: taskPath('cli-new-task', 'task.json'),
      taskMdPath: taskPath('cli-new-task', 'md'),
    });
    mockRunCommand.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    // Need repo dir to exist for .case/active write — make it a git repo
    const repoDir = join(tempDir, 'repo');
    await mkdir(repoDir, { recursive: true });

    // The test will fail on ensureBranch because Bun.spawn git isn't mocked.
    // Instead, verify that findTaskByIssue is checked first, and fetchIssue is called.
    // We verify orchestration logic, not git operations.
    try {
      await runCliOrchestrator({
        argument: '9999',
        mode: 'attended',
        dryRun: false,
        caseRoot: tempDir,
      });
    } catch {
      // Expected: git not available in test env
    }

    expect(mockFindTaskByIssue).toHaveBeenCalled();
    expect(mockFetchIssue).toHaveBeenCalled();
  });

  it('uses findTaskByMarker when no argument provided', async () => {
    // No branch field = skip branch checkout
    const task = makeTaskJson({ branch: undefined });
    mockFindTaskByMarker.mockResolvedValue({
      taskJson: task,
      taskJsonPath: taskPath('cli-abc-fix-test', 'task.json'),
      taskMdPath: taskPath('cli-abc-fix-test', 'md'),
      entryPhase: 'implement',
    });

    await runCliOrchestrator({
      argument: undefined,
      mode: 'attended',
      dryRun: false,
      caseRoot: tempDir,
    });

    expect(mockFindTaskByMarker).toHaveBeenCalledWith(tempDir, expect.stringContaining('repo'));
    expect(mockFindTaskByIssue).not.toHaveBeenCalled();
    expect(mockRunPipeline).toHaveBeenCalled();
  });

  it('prints usage when no argument and no marker found', async () => {
    mockFindTaskByMarker.mockResolvedValue(null);

    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    await runCliOrchestrator({
      argument: undefined,
      mode: 'attended',
      dryRun: false,
      caseRoot: tempDir,
    });

    process.stdout.write = origWrite;

    expect(writes.some((w) => w.includes('No active task found'))).toBe(true);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('exits early for pr-opened status', async () => {
    const task = makeTaskJson({
      status: 'pr-opened',
      prUrl: 'https://github.com/workos/cli/pull/42',
    });

    mockDetectArgumentType.mockReturnValue('github');
    mockFindTaskByIssue.mockResolvedValue({
      taskJson: task,
      taskJsonPath: taskPath('cli-abc-fix-test', 'task.json'),
      taskMdPath: taskPath('cli-abc-fix-test', 'md'),
      entryPhase: 'complete',
    });

    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    await runCliOrchestrator({
      argument: '1523',
      mode: 'attended',
      dryRun: false,
      caseRoot: tempDir,
    });

    process.stdout.write = origWrite;

    expect(writes.some((w) => w.includes('PR already exists'))).toBe(true);
    expect(writes.some((w) => w.includes('https://github.com/workos/cli/pull/42'))).toBe(true);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});
