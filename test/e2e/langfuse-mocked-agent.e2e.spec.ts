import { describe, it, expect } from 'vitest';
import { createLangfuseTracer } from '../../src/tracing/langfuse.js';
import { e2eEnabled, makeReadClient, pollTrace, byName, ofType } from './readback.js';
import type { SpawnAgentOptions } from '../../src/types.js';

/**
 * Phase 2.1 E2E — Tier 1: deterministic, no LLM.
 *
 * Drives the REAL `PiRuntimeAdapter.spawn` (the single observability seam) with a
 * mocked pi `Agent` that emits a fixed event sequence, a REAL `createLangfuseTracer`,
 * and a LIVE Langfuse — then reads the trace back and asserts the wire actually
 * carried what the adapter dispatched. This is the genuine §4 2.1 acceptance
 * ("a complete Langfuse trace with per-call token + cost"), minus LLM cost/flake.
 *
 * Covers what the unit spec cannot: the adapter's subscribe → tracer calls, the
 * real HTTP ingest, the usage/cost mapping, and rubric → score().
 *
 * Gated: runs only with LANGFUSE_E2E=1 + project keys (`bun run test:e2e`). The
 * default suite skips this describe entirely, so offline CI stays green.
 *
 * Preconditions: `podman-compose -f podman-compose.yaml up -d` and a seeded
 * project (LANGFUSE_INIT_PROJECT_PUBLIC_KEY/SECRET_KEY → LANGFUSE_PUBLIC_KEY/SECRET_KEY).
 */

const RUN_ID = `e2e-mock-${process.env.LANGFUSE_E2E_RUN ?? '0'}-${process.hrtime.bigint()}`;

// Fixed assistant message for turn_end → generation. Real-looking tokens + cost.
const TURN_MESSAGE = {
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  usage: {
    input: 1200,
    output: 340,
    cacheRead: 800,
    cacheWrite: 0,
    totalTokens: 2340,
    cost: { input: 0.0036, output: 0.0051, cacheRead: 0.0006, cacheWrite: 0, total: 0.0093 },
  },
};

// The verifier's parsed result — includes a rubric so the adapter emits score()s.
const AGENT_RESULT = `<<<AGENT_RESULT
{"status":"completed","summary":"verified the change","rubric":{"role":"verifier","categories":[{"category":"reproduced-scenario","verdict":"pass","detail":"ran the repro"},{"category":"edge-case-checked","verdict":"fail","detail":"missed the null path"}]}}
AGENT_RESULT>>>`;

/**
 * Mock pi Agent: replays the exact event shapes pi-adapter subscribes to.
 * Hoisted so the vi.mock factory below can reference it. The class is a real
 * `class` (not vi.fn) so `new MockAgent()` works under the Bun runtime.
 */
const { MockAgent } = vi.hoisted(() => {
  class MockAgent {
    private listeners: Array<(e: any, s: AbortSignal) => unknown> = [];
    constructor(public opts: unknown) {}
    subscribe(cb: (e: any, s: AbortSignal) => unknown): () => void {
      this.listeners.push(cb);
      return () => {};
    }
    async prompt(_input: string): Promise<void> {
      const signal = new AbortController().signal;
      for (const cb of this.listeners) {
        await cb(
          { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { cmd: 'bun test' } },
          signal,
        );
        await cb(
          { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { exitCode: 0 }, isError: false },
          signal,
        );
        await cb({ type: 'turn_end', message: TURN_MESSAGE, toolResults: [] }, signal);
        await cb(
          { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: AGENT_RESULT } },
          signal,
        );
      }
    }
    abort(): void {}
  }
  return { MockAgent };
});

// Mock only the two boundaries the adapter would otherwise hit for real:
//   - the pi Agent (no LLM / network)
//   - the system-prompt loader (no package-asset disk read)
// ModelRegistry/tool creators stay REAL: registry.find('anthropic','claude-sonnet-4-6')
// resolves offline against static metadata; tool constructors are pure.
vi.mock('@mariozechner/pi-agent-core', () => ({ Agent: MockAgent }));
vi.mock('../../src/agent/prompt-loader.js', () => ({ loadSystemPrompt: async () => '' }));

const { PiRuntimeAdapter } = await import('../../src/agent/adapters/pi-adapter.js');

describe.skipIf(!e2eEnabled())('langfuse e2e — mocked agent → live Langfuse', () => {
  it('dispatches a complete trace (phase span, generation w/ tokens+cost, tool span, scores) and keeps the TUI feed intact', async () => {
    const tracer = createLangfuseTracer(RUN_ID, { id: 'e2e-task' })!;
    expect(tracer).not.toBeNull();

    const toolActivity: Array<{ type: string; tool: string }> = [];
    const adapter = new PiRuntimeAdapter();

    const options: SpawnAgentOptions = {
      prompt: 'verify the change',
      cwd: process.cwd(),
      agentName: 'verifier',
      packageRoot: process.cwd(),
      dataDir: process.cwd(),
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      phase: 'verify',
      langfuse: tracer,
      onToolActivity: (e) => toolActivity.push({ type: e.type, tool: e.tool }),
    };

    const res = await adapter.spawn(options);

    // The run itself succeeded and the live TUI feed fired — independent of Langfuse.
    expect(res.result.status).toBe('completed');
    expect(toolActivity).toContainEqual({ type: 'start', tool: 'bash' });
    expect(toolActivity).toContainEqual({ type: 'end', tool: 'bash' });

    // Force the batched dispatch out before reading back.
    await tracer.shutdownSafely(10_000);

    const read = makeReadClient();
    const trace = await pollTrace(read, RUN_ID, { minObservations: 3, timeoutMs: 30_000 });

    // Phase span.
    expect(byName(trace.observations, 'phase:verify')).toBeDefined();

    // Tool span (nested).
    expect(byName(trace.observations, 'tool:bash')).toBeDefined();

    // Generation with per-call tokens AND cost — the NEW capability (RFC §2).
    const generations = ofType(trace.observations, 'GENERATION');
    expect(generations.length).toBeGreaterThanOrEqual(1);
    const gen = generations[0];
    const totalTokens = gen.usageDetails?.total ?? gen.usageDetails?.input ?? 0;
    expect(totalTokens).toBeGreaterThan(0);
    expect(gen.costDetails?.total ?? 0).toBeGreaterThan(0);

    // Rubric → scores, one per category.
    const scoreNames = trace.scores.map((s) => s.name);
    expect(scoreNames).toContain('verifier:reproduced-scenario');
    expect(scoreNames).toContain('verifier:edge-case-checked');

    await read.shutdownAsync();
  }, 60_000);
});
