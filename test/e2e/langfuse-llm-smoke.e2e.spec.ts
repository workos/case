import { describe, it, expect } from 'bun:test';
import { PiRuntimeAdapter } from '../../src/agent/adapters/pi-adapter.js';
import { createLangfuseTracer } from '../../src/tracing/langfuse.js';
import { llmE2eEnabled, makeReadClient, pollTrace, ofType } from './readback.js';
import type { SpawnAgentOptions } from '../../src/types.js';

/**
 * Phase 2.1 E2E — Tier 2: real LLM, manual smoke.
 *
 * Spawns a REAL agent against the configured model and dispatches to a LIVE
 * Langfuse, then reads back and asserts a generation with a non-zero **cost** —
 * the one thing only a real provider call can produce (token counts + dollar
 * cost are computed by pi from the actual API response). This is the true,
 * unmocked end-to-end path.
 *
 * Non-deterministic and billable, so it is gated separately from Tier 1:
 * runs only with LANGFUSE_E2E_LLM=1 (+ Langfuse keys + a working model auth).
 * Run via `bun run test:e2e:llm`. Never part of the default suite or Tier 1.
 *
 * Assertions are intentionally loose (>=1 generation, cost>0) — the model may or
 * may not call a tool, and token counts vary run to run.
 */

const RUN_ID = `e2e-llm-${process.hrtime.bigint()}`;

describe.skipIf(!llmE2eEnabled())('langfuse e2e — real LLM smoke', () => {
  it('produces a live trace with a real per-call cost', async () => {
    const tracer = createLangfuseTracer(RUN_ID, { id: 'e2e-llm-task' })!;
    expect(tracer).not.toBeNull();

    const adapter = new PiRuntimeAdapter();

    // Minimal, cheap prompt: ask the model to emit a valid AGENT_RESULT and stop.
    const options: SpawnAgentOptions = {
      prompt:
        'Reply with EXACTLY this and nothing else:\n' +
        '<<<AGENT_RESULT\n{"status":"completed","summary":"e2e smoke"}\nAGENT_RESULT>>>',
      cwd: process.cwd(),
      agentName: 'scout', // read-only toolset — safe in any cwd
      packageRoot: process.cwd(),
      dataDir: process.cwd(),
      phase: 'scout',
      timeout: 120_000,
      langfuse: tracer,
    };

    const res = await adapter.spawn(options);
    // Don't hard-fail on the model's status (it may editorialize); the trace is the point.
    expect(res.durationMs).toBeGreaterThan(0);

    await tracer.shutdownSafely(15_000);

    const read = makeReadClient();
    const trace = await pollTrace(read, RUN_ID, { minObservations: 1, timeoutMs: 45_000 });

    const generations = ofType(trace.observations, 'GENERATION');
    expect(generations.length).toBeGreaterThanOrEqual(1);
    const totalCost = generations.reduce((sum, g) => sum + (g.costDetails?.total ?? 0), 0);
    expect(totalCost).toBeGreaterThan(0);

    await read.shutdownAsync();
  }, 180_000);
});
