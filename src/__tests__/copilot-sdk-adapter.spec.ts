import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * GitHub Copilot SDK adapter contract test.
 *
 * Mocks `@github/copilot-sdk`'s CopilotClient/CopilotSession with a scripted
 * event stream (message_delta → tool start → tool complete → usage → terminal
 * assistant.message) and asserts the adapter maps it into: the canonical raw
 * text, a parsed AgentResult, the full Langfuse span sequence (toolStart/toolEnd
 * → generation → end), renderer tool-activity callbacks, the read-only/mutable
 * permission seam, and the not-authenticated fail-fast path. Also asserts the
 * provider router dispatches `provider: 'copilot'` to this runtime.
 */

const { scripted, captured, authState } = vi.hoisted(() => {
  const RESULT = '<<<AGENT_RESULT {"status":"completed","summary":"done"} AGENT_RESULT>>>';
  return {
    authState: { isAuthenticated: true },
    captured: { finalContent: RESULT } as {
      clientOptions?: Record<string, unknown>;
      config?: { model?: string; onPermissionRequest?: (r: { kind: string }) => unknown; systemMessage?: unknown };
      finalContent: string;
    },
    scripted: [
      { type: 'assistant.message_delta', data: { deltaContent: 'working ' } },
      { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'read', arguments: { path: 'x.ts' } } },
      { type: 'tool.execution_complete', data: { toolCallId: 't1', success: true, result: 'file body' } },
      {
        type: 'assistant.usage',
        data: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, cost: 0.0012 },
      },
    ],
  };
});

vi.mock('@github/copilot-sdk', () => {
  class CopilotSession {
    private handlers: ((e: unknown) => void)[] = [];
    on(arg1: unknown, _arg2?: unknown) {
      if (typeof arg1 === 'function') this.handlers.push(arg1 as (e: unknown) => void);
      return () => {};
    }
    async sendAndWait(_opts: unknown, _timeout?: number) {
      for (const ev of scripted) for (const h of this.handlers) h(ev);
      return { type: 'assistant.message', data: { content: captured.finalContent } };
    }
    async disconnect() {}
    async abort() {}
  }
  class CopilotClient {
    constructor(options: Record<string, unknown>) {
      captured.clientOptions = options;
    }
    async start() {}
    async getAuthStatus() {
      return { ...authState };
    }
    async createSession(config: Record<string, unknown>) {
      captured.config = config;
      return new CopilotSession();
    }
    async stop() {
      return [];
    }
  }
  return { CopilotClient, approveAll: () => ({ kind: 'approve-once' }) };
});

const { CopilotSdkRuntime } = await import('../agent/adapters/copilot-sdk-adapter.js');
const { ProviderRoutingRuntime } = await import('../agent/adapters/provider-routing-runtime.js');

/** Fake Langfuse span recorder. */
function recorder() {
  const calls: Record<string, unknown[]> = { generation: [], toolStart: [], toolEnd: [], score: [], end: [] };
  const span = {
    generation: (m: unknown) => calls.generation.push(m),
    toolStart: (...a: unknown[]) => calls.toolStart.push(a),
    toolEnd: (...a: unknown[]) => calls.toolEnd.push(a),
    score: (r: unknown) => calls.score.push(r),
    end: (...a: unknown[]) => calls.end.push(a),
    event: () => {},
  };
  return { calls, langfuse: { startAgentSpan: () => span, event: () => {} } };
}

const pkgRoot = join(process.env.TMPDIR ?? '/tmp', `case-copilot-adapter-${Date.now()}`);

describe('CopilotSdkRuntime.spawn (mocked SDK)', () => {
  beforeEach(async () => {
    authState.isAuthenticated = true;
    captured.config = undefined;
    captured.clientOptions = undefined;
    await mkdir(join(pkgRoot, 'agents'), { recursive: true });
    await writeFile(join(pkgRoot, 'agents', 'scout.md'), '# Scout\n\nExplore.', 'utf8');
    await writeFile(join(pkgRoot, 'agents', 'implementer.md'), '# Implementer\n\nBuild.', 'utf8');
  });
  afterAll(async () => {
    await rm(pkgRoot, { recursive: true, force: true });
  });

  const baseOpts = (extra: Record<string, unknown>) => ({
    prompt: 'go',
    cwd: '/repos/cli',
    agentName: 'scout' as const,
    packageRoot: pkgRoot,
    dataDir: '/data',
    model: 'gpt-5',
    provider: 'copilot',
    ...extra,
  });

  it('maps the scripted stream into raw text, AgentResult, and span events', async () => {
    const rec = recorder();
    const res = await new CopilotSdkRuntime().spawn(baseOpts({ langfuse: rec.langfuse }));

    expect(res.raw).toContain('"status":"completed"');
    expect(res.result.status).toBe('completed');
    expect(res.result.summary).toBe('done');

    // Tool start/end paired by toolCallId; complete carries no toolName.
    expect(rec.calls.toolStart).toHaveLength(1);
    expect(rec.calls.toolStart[0]).toEqual(['t1', 'read', expect.anything()]);
    expect(rec.calls.toolEnd).toHaveLength(1);
    expect(rec.calls.toolEnd[0][1]).toBe('read');
    expect(rec.calls.toolEnd[0][3]).toBe(false);

    // Usage → generation; phase close → end.
    expect(rec.calls.generation).toHaveLength(1);
    expect((rec.calls.generation[0] as { usage: { input: number; output: number } }).usage.input).toBe(10);
    expect(rec.calls.end).toHaveLength(1);
  });

  it('fires renderer tool-activity callbacks', async () => {
    const events: { type: string; tool: string }[] = [];
    await new CopilotSdkRuntime().spawn(
      baseOpts({ onToolActivity: (e: { type: string; tool: string }) => events.push(e) }),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'start', tool: 'read' }),
      expect.objectContaining({ type: 'end', tool: 'read' }),
    ]);
  });

  it('replaces the system prompt with the role prompt', async () => {
    await new CopilotSdkRuntime().spawn(baseOpts({}));
    expect(captured.config?.systemMessage).toEqual({ mode: 'replace', content: expect.stringContaining('Scout') });
  });

  it('enforces a read-only permission seam for scout (rejects write, allows read/shell)', async () => {
    await new CopilotSdkRuntime().spawn(baseOpts({}));
    const handler = captured.config!.onPermissionRequest!;
    expect(handler({ kind: 'write' })).toEqual({ kind: 'reject', feedback: expect.any(String) });
    expect(handler({ kind: 'read' })).toEqual({ kind: 'approve-once' });
    expect(handler({ kind: 'shell' })).toEqual({ kind: 'approve-once' });
  });

  it('approves writes for mutable roles (implementer)', async () => {
    await new CopilotSdkRuntime().spawn(baseOpts({ agentName: 'implementer' as const }));
    const handler = captured.config!.onPermissionRequest!;
    expect(handler({ kind: 'write' })).toEqual({ kind: 'approve-once' });
  });

  it('fails fast with an actionable message when not authenticated', async () => {
    authState.isAuthenticated = false;
    const res = await new CopilotSdkRuntime().spawn(baseOpts({}));
    expect(res.result.status).toBe('failed');
    expect(res.result.error).toContain('not authenticated');
    expect(captured.config).toBeUndefined(); // never reached createSession
  });
});

describe('ProviderRoutingRuntime → Copilot', () => {
  beforeEach(async () => {
    authState.isAuthenticated = true;
    captured.config = undefined;
    await mkdir(join(pkgRoot, 'agents'), { recursive: true });
    await writeFile(join(pkgRoot, 'agents', 'scout.md'), '# Scout\n\nExplore.', 'utf8');
  });

  it('routes provider "copilot" to the Copilot SDK runtime', async () => {
    const res = await new ProviderRoutingRuntime().spawn({
      prompt: 'go',
      cwd: '/repos/cli',
      agentName: 'scout',
      packageRoot: pkgRoot,
      dataDir: '/data',
      provider: 'copilot',
      model: 'gpt-5',
    });
    expect(res.result.status).toBe('completed');
    expect(captured.config?.model).toBe('gpt-5'); // copilot path created the session
  });

  it('honors CASE_AGENT_RUNTIME=copilot as an explicit override', async () => {
    process.env.CASE_AGENT_RUNTIME = 'copilot';
    try {
      const res = await new ProviderRoutingRuntime().spawn({
        prompt: 'go',
        cwd: '/repos/cli',
        agentName: 'scout',
        packageRoot: pkgRoot,
        dataDir: '/data',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });
      expect(res.result.status).toBe('completed');
      expect(captured.config?.model).toBe('claude-sonnet-4-6');
    } finally {
      delete process.env.CASE_AGENT_RUNTIME;
    }
  });
});
