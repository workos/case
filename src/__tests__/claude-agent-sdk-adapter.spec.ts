import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Claude Agent SDK adapter contract test.
 *
 * Mocks `@anthropic-ai/claude-agent-sdk`'s `query` with a scripted message
 * stream (assistant text → tool_use → tool_result → result) and asserts the
 * adapter maps it into: accumulated raw text, a parsed AgentResult, and the
 * full Langfuse span sequence (startAgentSpan → toolStart/toolEnd → generation
 * → end) plus the renderer tool-activity callbacks.
 */

const RESULT_BLOCK = '<<<AGENT_RESULT {"status":"completed","summary":"done"} AGENT_RESULT>>>';

const scripted = [
  { type: 'assistant', message: { content: [{ type: 'text', text: 'working ' }] } },
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x.ts' } }] },
  },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false }] },
  },
  {
    type: 'result',
    subtype: 'success',
    result: RESULT_BLOCK,
    total_cost_usd: 0.0012,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
  },
];

let capturedOptions: unknown = null;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: unknown }) => {
    capturedOptions = options;
    return (async function* () {
      for (const m of scripted) yield m;
    })();
  },
}));

const { ClaudeAgentSdkRuntime } = await import('../agent/adapters/claude-agent-sdk-adapter.js');

// Fake Langfuse span recorder.
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

const pkgRoot = join(process.env.TMPDIR ?? '/tmp', `case-sdk-adapter-${Date.now()}`);

describe('ClaudeAgentSdkRuntime.spawn (mocked query)', () => {
  beforeEach(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    await mkdir(join(pkgRoot, 'agents'), { recursive: true });
    await writeFile(join(pkgRoot, 'agents', 'scout.md'), '# Scout\n\nExplore.', 'utf8');
  });
  afterAll(async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await rm(pkgRoot, { recursive: true, force: true });
  });

  const baseOpts = (extra: Record<string, unknown>) => ({
    prompt: 'go',
    cwd: '/repos/cli',
    agentName: 'scout' as const,
    packageRoot: pkgRoot,
    dataDir: '/data',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    ...extra,
  });

  it('parses the AGENT_RESULT block from the result frame', async () => {
    const res = await new ClaudeAgentSdkRuntime().spawn(baseOpts({}));
    expect(res.result.status).toBe('completed');
    expect(res.result.summary).toBe('done');
    expect(res.raw).toBe(RESULT_BLOCK);
  });

  it('emits the full span sequence with neutral usage shape', async () => {
    const { calls, langfuse } = recorder();
    await new ClaudeAgentSdkRuntime().spawn(baseOpts({ langfuse }));

    expect(calls.toolStart).toHaveLength(1);
    expect(calls.toolStart[0]).toEqual(['t1', 'read', expect.anything()]);
    expect(calls.toolEnd).toHaveLength(1);
    expect((calls.toolEnd[0] as unknown[])[1]).toBe('read');

    expect(calls.generation).toHaveLength(1);
    expect(calls.generation[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.0012 } },
    });

    expect(calls.end).toHaveLength(1);
    expect((calls.end[0] as unknown[])[1]).toBe(false); // not an error
  });

  it('fires renderer tool-activity callbacks (start + end)', async () => {
    const activity: string[] = [];
    await new ClaudeAgentSdkRuntime().spawn(
      baseOpts({ onToolActivity: (e: { type: string }) => activity.push(e.type) }),
    );
    expect(activity).toEqual(['start', 'end']);
  });

  it('enforces read-only tool policy for scout (no Write/Edit)', async () => {
    await new ClaudeAgentSdkRuntime().spawn(baseOpts({}));
    const opts = capturedOptions as { allowedTools: string[]; disallowedTools: string[]; permissionMode: string };
    expect(opts.allowedTools).not.toContain('Write');
    expect(opts.allowedTools).not.toContain('Edit');
    expect(opts.disallowedTools).toEqual(['Write', 'Edit']);
    expect(opts.permissionMode).toBe('bypassPermissions');
  });
});
