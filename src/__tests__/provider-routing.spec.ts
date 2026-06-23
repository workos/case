import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * ProviderRoutingRuntime + routing-helper tests.
 *
 * The three backend adapters are mocked so each `spawn` returns a sentinel
 * identifying which backend handled it — letting us assert routing by model
 * provider and by the CASE_AGENT_RUNTIME override without real LLM/SDK calls.
 */

// Mock the three backends BEFORE importing the router. Each spawn echoes its
// backend name in `raw` so the test can read the routing decision. `fakeRuntime`
// is created inside vi.hoisted so the hoisted vi.mock factories can reference it.
const { fakeRuntime } = vi.hoisted(() => {
  function fakeRuntime(name: string) {
    return class {
      async spawn() {
        return { raw: name, result: { status: 'completed' }, durationMs: 0 };
      }
      createTools() {
        return [name];
      }
      abort() {}
    };
  }
  return { fakeRuntime };
});

vi.mock('../agent/adapters/claude-agent-sdk-adapter.js', () => ({
  ClaudeAgentSdkRuntime: fakeRuntime('sdk'),
}));
vi.mock('../agent/adapters/langchain-adapter.js', () => ({
  LangChainRuntime: fakeRuntime('langchain'),
}));
vi.mock('../agent/adapters/pi-adapter.js', () => ({
  PiRuntimeAdapter: fakeRuntime('pi'),
}));

const { ProviderRoutingRuntime } = await import('../agent/adapters/provider-routing-runtime.js');
const { isClaudeModel, toolPolicyFor, resolveAgentModel } = await import('../agent/config.js');

// Explicit provider+model so resolveAgentModel never touches the config file.
function opts(provider: string, model: string) {
  return {
    prompt: 'go',
    cwd: '/repos/cli',
    agentName: 'scout' as const,
    packageRoot: '/pkg',
    dataDir: '/data',
    provider,
    model,
  };
}

describe('isClaudeModel', () => {
  it('routes Anthropic provider to Claude', () => {
    expect(isClaudeModel({ provider: 'anthropic', model: 'claude-sonnet-4' })).toBe(true);
  });
  it('routes by model id when provider is absent/aliased', () => {
    expect(isClaudeModel({ model: 'claude-opus-4-8' })).toBe(true);
    expect(isClaudeModel({ model: 'opus' })).toBe(true);
    expect(isClaudeModel({ model: 'haiku' })).toBe(true);
  });
  it('treats OpenAI/Google models as non-Claude', () => {
    expect(isClaudeModel({ provider: 'openai', model: 'gpt-4o' })).toBe(false);
    expect(isClaudeModel({ provider: 'google', model: 'gemini-1.5-pro' })).toBe(false);
  });
  it('routes OpenRouter to LangChain even for Claude-id models', () => {
    expect(isClaudeModel({ provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet' })).toBe(false);
    expect(isClaudeModel({ provider: 'openrouter', model: 'google/gemini-2.5-pro' })).toBe(false);
  });
});

describe('toolPolicyFor', () => {
  it('grants mutable to implementer and retrospective', () => {
    expect(toolPolicyFor('implementer')).toBe('mutable');
    expect(toolPolicyFor('retrospective')).toBe('mutable');
  });
  it('keeps everyone else read-only', () => {
    for (const a of ['scout', 'verifier', 'reviewer', 'closer', 'interviewer', 'unknown']) {
      expect(toolPolicyFor(a)).toBe('read-only');
    }
  });
});

describe('resolveAgentModel', () => {
  const original = process.env.CASE_MODEL_OVERRIDE;
  afterEach(() => {
    if (original === undefined) delete process.env.CASE_MODEL_OVERRIDE;
    else process.env.CASE_MODEL_OVERRIDE = original;
  });

  it('prefers explicit options.model', async () => {
    const m = await resolveAgentModel({ agentName: 'scout', model: 'gpt-4o', provider: 'openai' });
    expect(m).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });
  it('falls back to CASE_MODEL_OVERRIDE (anthropic by default)', async () => {
    delete process.env.CASE_MODEL_OVERRIDE;
    process.env.CASE_MODEL_OVERRIDE = 'claude-haiku-4-5';
    const m = await resolveAgentModel({ agentName: 'scout' });
    expect(m).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });
});

describe('ProviderRoutingRuntime routing', () => {
  const original = process.env.CASE_AGENT_RUNTIME;
  beforeEach(() => delete process.env.CASE_AGENT_RUNTIME);
  afterEach(() => {
    if (original === undefined) delete process.env.CASE_AGENT_RUNTIME;
    else process.env.CASE_AGENT_RUNTIME = original;
  });

  it('routes Claude models to the Agent SDK backend', async () => {
    const r = new ProviderRoutingRuntime();
    const res = await r.spawn(opts('anthropic', 'claude-sonnet-4-6'));
    expect(res.raw).toBe('sdk');
  });

  it('routes non-Claude models to the LangChain backend', async () => {
    const r = new ProviderRoutingRuntime();
    expect((await r.spawn(opts('openai', 'gpt-4o'))).raw).toBe('langchain');
    expect((await r.spawn(opts('google', 'gemini-1.5-pro'))).raw).toBe('langchain');
  });

  it('routes OpenRouter Claude-id models to LangChain (not the SDK)', async () => {
    const r = new ProviderRoutingRuntime();
    expect((await r.spawn(opts('openrouter', 'anthropic/claude-3.5-sonnet'))).raw).toBe('langchain');
  });

  it('CASE_AGENT_RUNTIME=pi forces the pi backend regardless of model', async () => {
    process.env.CASE_AGENT_RUNTIME = 'pi';
    const r = new ProviderRoutingRuntime();
    expect((await r.spawn(opts('anthropic', 'claude-sonnet-4-6'))).raw).toBe('pi');
    expect((await r.spawn(opts('openai', 'gpt-4o'))).raw).toBe('pi');
  });

  it('CASE_AGENT_RUNTIME=langchain forces LangChain even for Claude', async () => {
    process.env.CASE_AGENT_RUNTIME = 'langchain';
    const r = new ProviderRoutingRuntime();
    expect((await r.spawn(opts('anthropic', 'claude-sonnet-4-6'))).raw).toBe('langchain');
  });

  it('createTools delegates to the last-active backend', async () => {
    const r = new ProviderRoutingRuntime();
    await r.spawn(opts('openai', 'gpt-4o'));
    expect(r.createTools('scout', '/repos/cli')).toEqual(['langchain']);
  });
});
