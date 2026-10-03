import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLangfuseTracer } from '../tracing/langfuse.js';
import type { Rubric } from '../types.js';

/**
 * Phase 2.1 NET-NEW — the §7 risk-row oracle: **an unreachable/absent Langfuse is
 * a no-op for the run.** Langfuse dispatch is fire-and-forget; the tracer is the
 * wrapper the adapter trusts, so the guarantee that `pi-adapter` never throws into
 * the control path (and never disturbs the onToolActivity/heartbeat TUI feed) rests
 * entirely on every tracer method being self-defensive. This proves that contract:
 *
 *   - keys absent  → tracer is null → Case runs JSONL-only, unchanged.
 *   - keys present, sink unreachable → the full adapter call sequence
 *     (span → generation → tool spans → score → end → flush/shutdown) never throws.
 *
 * It deliberately points at a dead port so dispatch genuinely fails in the
 * background; if any method propagated that failure, the run would break.
 */

const KEYS = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  // Reserved, almost-certainly-closed port → every dispatch attempt fails.
  LANGFUSE_HOST: 'http://127.0.0.1:1',
};

const SAVED: Record<string, string | undefined> = {};
const ENV_KEYS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST', 'LANGFUSE_BASE_URL'];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

const TASK = { id: 'repo-123-fix', title: 'Fix the thing' };

const VERIFIER_RUBRIC: Rubric = {
  role: 'verifier',
  categories: [
    { category: 'reproduced-scenario', verdict: 'pass', detail: 'ran the repro' },
    { category: 'edge-case-checked', verdict: 'fail', detail: 'missed null path' },
  ],
};

const PI_MESSAGE = {
  model: 'claude-sonnet-4-20250514',
  usage: {
    input: 1200,
    output: 340,
    cacheRead: 800,
    cacheWrite: 0,
    totalTokens: 1540,
    cost: { input: 0.0036, output: 0.0051, cacheRead: 0.0006, cacheWrite: 0, total: 0.0093 },
  },
};

describe('langfuse dispatch — disabled when keys absent', () => {
  it('returns null without public/secret keys (JSONL-only, unchanged behavior)', () => {
    expect(createLangfuseTracer('run-1', TASK)).toBeNull();
  });

  it('returns null when only one key is present', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-only';
    expect(createLangfuseTracer('run-2', TASK)).toBeNull();
  });
});

describe('langfuse dispatch — unreachable sink is a no-op for the run', () => {
  beforeEach(() => Object.assign(process.env, KEYS));

  it('constructs a tracer when keys are present', () => {
    const tracer = createLangfuseTracer('run-3', TASK);
    expect(tracer).not.toBeNull();
  });

  it('drives the full adapter event sequence without throwing', () => {
    const tracer = createLangfuseTracer('run-4', TASK)!;

    // Exactly the call order pi-adapter.ts issues per spawn.
    expect(() => {
      const span = tracer.startAgentSpan('verifier', 'verify');
      span.generation(PI_MESSAGE); // turn_end
      span.toolStart('t1', 'bash', { cmd: 'bun test' }); // tool_execution_start
      span.toolEnd('t1', 'bash', { exitCode: 0 }, false); // tool_execution_end
      span.event('scout_completed', { findings: 3 }); // domain event
      span.score(VERIFIER_RUBRIC); // rubric → score()
      span.end({ status: 'completed' }, false); // agent_end
    }).not.toThrow();
  });

  it('tolerates malformed / empty inputs (no usage, unknown tool end, NA verdicts)', () => {
    const tracer = createLangfuseTracer('run-5', TASK)!;
    expect(() => {
      const span = tracer.startAgentSpan('scout');
      span.generation({}); // no model, no usage
      span.toolEnd('never-started', 'grep', undefined, true); // end without start
      span.score({ role: 'reviewer', categories: [{ category: 'pattern-fit', verdict: 'na', detail: '' }] });
      span.end();
    }).not.toThrow();
  });

  it('flushSafely never throws against a dead sink', () => {
    const tracer = createLangfuseTracer('run-6', TASK)!;
    expect(() => tracer.flushSafely()).not.toThrow();
  });

  it('shutdownSafely resolves (bounded) against a dead sink', async () => {
    const tracer = createLangfuseTracer('run-7', TASK)!;
    // Tight timeout: proves the race-against-timeout bound — a hung sink cannot
    // stall run teardown.
    await expect(tracer.shutdownSafely(200)).resolves.toBeUndefined();
  });
});
