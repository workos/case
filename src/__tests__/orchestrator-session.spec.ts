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
const mockCreateAgentSessionRuntime = mock();
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

const mockSession = { id: 'test-session' };
const mockRuntime = {
  session: mockSession,
  diagnostics: [],
  modelFallbackMessage: undefined as string | undefined,
};

mock.module('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  createAgentSessionRuntime: mockCreateAgentSessionRuntime,
  InteractiveMode: class MockInteractiveMode {
    runtime: unknown;
    options: unknown;
    constructor(runtime: unknown, options?: unknown) {
      this.runtime = runtime;
      this.options = options;
    }
    async run() {
      return mockInteractiveModeRun(this.runtime, this.options);
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
  SettingsManager: { create: () => ({ setQuietStartup: () => {}, setWarnings: () => {}, getWarnings: () => ({}) }) },
  SessionManager: { create: () => ({}) },
  AuthStorage: { create: () => ({}) },
  ModelRegistry: {
    create: () => ({
      find() {
        return { id: 'mock-model' };
      },
    }),
  },
  getAgentDir: () => '/tmp/pi-agent',
  createReadTool: () => ({ name: 'read' }),
  createWriteTool: () => ({ name: 'write' }),
  createEditTool: () => ({ name: 'edit' }),
  createBashTool: () => ({ name: 'bash' }),
}));

const { startOrchestratorSession } = await import('../agent/orchestrator-session.js');

const mockDetected = {
  name: 'cli',
  path: '/repos/cli',
  project: {
    name: 'cli',
    path: '../cli/main',
    remote: 'git@github.com:workos/cli.git',
    language: 'ts',
    packageManager: 'pnpm',
    commands: {},
  },
};

describe('startOrchestratorSession', () => {
  beforeEach(() => {
    mockCreateAgentSession.mockReset();
    mockCreateAgentSessionRuntime.mockReset();
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
      services: {},
      diagnostics: [],
    });

    // createAgentSessionRuntime calls the factory internally, so we mock it
    // to call the factory once (to exercise our tool registration code) then
    // return the mock runtime.
    mockCreateAgentSessionRuntime.mockImplementation(async (factory: Function, opts: any) => {
      await factory(opts);
      return { ...mockRuntime };
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
    expect(options.initialMessage).toContain('What would you like to work on?');
  });

  it('does not auto-detect active task when no argument provided', async () => {
    await startOrchestratorSession({ caseRoot: '/case', mode: 'attended' });

    expect(mockFindTaskByMarker).not.toHaveBeenCalled();
    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.initialMessage).not.toContain('Active task');
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
      taskJsonPath: '/repos/cli/.case/tasks/active/cli-1234.task.json',
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

  it('includes caseRoot in system prompt via appendSystemPrompt array', async () => {
    await startOrchestratorSession({ caseRoot: '/my/case/root', mode: 'attended' });

    const opts = mockResourceLoaderReload.mock.calls[0][0];
    expect(opts.appendSystemPrompt).toBeInstanceOf(Array);
    expect(opts.appendSystemPrompt[0]).toContain('/my/case/root');
  });

  it('passes modelFallbackMessage to InteractiveMode', async () => {
    mockCreateAgentSessionRuntime.mockImplementation(async (factory: Function, opts: any) => {
      await factory(opts);
      return { ...mockRuntime, modelFallbackMessage: 'Fell back to default model' };
    });

    await startOrchestratorSession({ caseRoot: '/case', mode: 'attended' });

    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.modelFallbackMessage).toBe('Fell back to default model');
  });
});
