import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Orchestrator session tests.
 *
 * These test the session setup logic — tool registration, context gathering,
 * system prompt construction. The actual Pi session is mocked since it requires
 * auth credentials and a TUI.
 */

// Mock the Pi SDK before importing the module under test
const mockCreateAgentSession = mock();
const mockInteractiveModeRun = mock();
const mockResourceLoaderReload = mock();

// Mock config module to avoid filesystem reads
mock.module('../agent/config.js', () => ({
  getModelForAgent: async () => ({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }),
  loadConfig: async () => ({}),
}));

// Mock entry modules for context gathering
const mockDetectRepo = mock();
const mockFindTaskByIssue = mock();
const mockFindTaskByMarker = mock();
const mockFetchIssue = mock();

mock.module('../entry/repo-detector.js', () => ({ detectRepo: mockDetectRepo }));
mock.module('../entry/task-scanner.js', () => ({
  findTaskByIssue: mockFindTaskByIssue,
  findTaskByMarker: mockFindTaskByMarker,
}));
mock.module('../entry/issue-fetcher.js', () => ({
  detectArgumentType: (arg: string) => (/^\d+$/.test(arg) ? 'github' : 'freeform'),
  fetchIssue: mockFetchIssue,
}));

mock.module('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  InteractiveMode: class MockInteractiveMode {
    session: unknown;
    options: unknown;
    constructor(session: unknown, options?: unknown) {
      this.session = session;
      this.options = options;
    }
    async run() {
      return mockInteractiveModeRun(this.session, this.options);
    }
  },
  DefaultResourceLoader: class MockResourceLoader {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
    async reload() {
      return mockResourceLoaderReload(this.options);
    }
  },
  SettingsManager: { create: () => ({}) },
  AuthStorage: { create: () => ({}) },
  ModelRegistry: class {
    constructor() {}
    find() {
      return { id: 'mock-model' };
    }
  },
  getAgentDir: () => '/tmp/pi-agent',
}));

const { startOrchestratorSession } = await import('../agent/orchestrator-session.js');

const mockDetected = {
  name: 'cli',
  path: '/repos/cli',
  project: { name: 'cli', path: '../cli/main', remote: 'git@github.com:workos/cli.git', language: 'ts', packageManager: 'pnpm', commands: {} },
};

describe('startOrchestratorSession', () => {
  const mockSession = { id: 'test-session' };

  beforeEach(() => {
    mockCreateAgentSession.mockReset();
    mockInteractiveModeRun.mockReset();
    mockResourceLoaderReload.mockReset();
    mockDetectRepo.mockReset();
    mockFindTaskByIssue.mockReset();
    mockFindTaskByMarker.mockReset();
    mockFetchIssue.mockReset();

    mockCreateAgentSession.mockResolvedValue({
      session: mockSession,
      extensionsResult: {},
      modelFallbackMessage: undefined,
    });
    mockInteractiveModeRun.mockResolvedValue(undefined);
    mockResourceLoaderReload.mockResolvedValue(undefined);
    mockDetectRepo.mockResolvedValue(mockDetected);
    mockFindTaskByIssue.mockResolvedValue(null);
    mockFindTaskByMarker.mockResolvedValue(null);
  });

  it('creates session with four custom tools', async () => {
    await startOrchestratorSession({ caseRoot: '/case', mode: 'attended' });

    expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
    const opts = mockCreateAgentSession.mock.calls[0][0];
    expect(opts.customTools).toHaveLength(4);

    const toolNames = opts.customTools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('run_pipeline');
    expect(toolNames).toContain('fetch_issue');
    expect(toolNames).toContain('create_task');
    expect(toolNames).toContain('run_baseline');
  });

  it('detects repo and includes it in initial message', async () => {
    await startOrchestratorSession({ caseRoot: '/case', mode: 'attended' });

    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.initialMessage).toContain('Repo: cli');
    expect(options.initialMessage).toContain('No active task');
  });

  it('includes existing task context when marker found', async () => {
    mockFindTaskByMarker.mockResolvedValue({
      taskJson: { id: 'cli-1', status: 'implementing' },
      taskJsonPath: '/case/tasks/active/cli-1.task.json',
      entryPhase: 'verify',
    });

    await startOrchestratorSession({ caseRoot: '/case', mode: 'attended' });

    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.initialMessage).toContain('Active task: cli-1');
    expect(options.initialMessage).toContain('implementing');
  });

  it('fetches issue context when argument provided', async () => {
    mockFetchIssue.mockResolvedValue({
      title: 'Fix login bug',
      body: 'Users cannot log in',
      labels: [],
      issueType: 'github',
      issueNumber: '1234',
    });

    await startOrchestratorSession({ caseRoot: '/case', argument: '1234', mode: 'attended' });

    expect(mockFetchIssue).toHaveBeenCalledTimes(1);
    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.initialMessage).toContain('Fix login bug');
    expect(options.initialMessage).toContain('Users cannot log in');
  });

  it('shows existing task instead of fetching when task matches argument', async () => {
    mockFindTaskByIssue.mockResolvedValue({
      taskJson: { id: 'cli-1234', status: 'verifying', prUrl: null },
      taskJsonPath: '/case/tasks/active/cli-1234.task.json',
      entryPhase: 'verify',
    });

    await startOrchestratorSession({ caseRoot: '/case', argument: '1234', mode: 'attended' });

    expect(mockFetchIssue).not.toHaveBeenCalled();
    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.initialMessage).toContain('Existing task found: cli-1234');
    expect(options.initialMessage).toContain('verifying');
  });

  it('handles repo detection failure gracefully', async () => {
    mockDetectRepo.mockRejectedValue(new Error('Not in a target repo'));

    await startOrchestratorSession({ caseRoot: '/case', argument: '1234', mode: 'attended' });

    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.initialMessage).toContain('Work on issue: 1234');
    expect(options.initialMessage).toContain('Not in a recognized target repo');
  });

  it('includes caseRoot in system prompt', async () => {
    await startOrchestratorSession({ caseRoot: '/my/case/root', mode: 'attended' });

    const opts = mockResourceLoaderReload.mock.calls[0][0];
    expect(opts.appendSystemPrompt).toContain('/my/case/root');
  });

  it('passes modelFallbackMessage to InteractiveMode', async () => {
    mockCreateAgentSession.mockResolvedValue({
      session: mockSession,
      extensionsResult: {},
      modelFallbackMessage: 'Fell back to default model',
    });

    await startOrchestratorSession({ caseRoot: '/case', mode: 'attended' });

    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.modelFallbackMessage).toBe('Fell back to default model');
  });
});
