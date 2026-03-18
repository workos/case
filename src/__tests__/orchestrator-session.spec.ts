import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Orchestrator session tests.
 *
 * These test the session setup logic — tool registration, argument handling,
 * system prompt construction. The actual Pi session is mocked since it requires
 * auth credentials and a TUI.
 */

// Mock the Pi SDK before importing the module under test
const mockCreateAgentSession = mock();
const mockInteractiveModeRun = mock();
const mockResourceLoaderReload = mock();

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
  ModelRegistry: class { constructor() {} },
  getAgentDir: () => '/tmp/pi-agent',
}));

const { startOrchestratorSession } = await import('../agent/orchestrator-session.js');

describe('startOrchestratorSession', () => {
  const mockSession = { id: 'test-session' };

  beforeEach(() => {
    mockCreateAgentSession.mockReset();
    mockInteractiveModeRun.mockReset();
    mockResourceLoaderReload.mockReset();

    mockCreateAgentSession.mockResolvedValue({
      session: mockSession,
      extensionsResult: {},
      modelFallbackMessage: undefined,
    });
    mockInteractiveModeRun.mockResolvedValue(undefined);
    mockResourceLoaderReload.mockResolvedValue(undefined);
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

  it('passes no initialMessage when no argument provided', async () => {
    await startOrchestratorSession({ caseRoot: '/case', mode: 'attended' });

    expect(mockInteractiveModeRun).toHaveBeenCalledTimes(1);
    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.initialMessage).toBeUndefined();
  });

  it('passes initialMessage when argument provided', async () => {
    await startOrchestratorSession({ caseRoot: '/case', argument: '1234', mode: 'attended' });

    expect(mockInteractiveModeRun).toHaveBeenCalledTimes(1);
    const [, options] = mockInteractiveModeRun.mock.calls[0];
    expect(options.initialMessage).toBe('Work on issue: 1234');
  });

  it('reloads resource loader before creating session', async () => {
    await startOrchestratorSession({ caseRoot: '/case', mode: 'attended' });

    expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
    // Resource loader reload is called with the options that include appendSystemPrompt
    const opts = mockResourceLoaderReload.mock.calls[0][0];
    expect(opts.appendSystemPrompt).toBeDefined();
    expect(opts.appendSystemPrompt).toContain('Case orchestrator');
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

  it('includes caseRoot in system prompt', async () => {
    await startOrchestratorSession({ caseRoot: '/my/case/root', mode: 'attended' });

    const opts = mockResourceLoaderReload.mock.calls[0][0];
    expect(opts.appendSystemPrompt).toContain('/my/case/root');
  });
});
