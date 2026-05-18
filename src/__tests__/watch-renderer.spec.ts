import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { renderWatchEvent } from '../watch/renderer.js';
import type { PipelineEvent } from '../events/schema.js';

// Lock color OFF so we can assert on exact plain-text shapes.
let savedNoColor: string | undefined;
let savedForceColor: string | undefined;

beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  savedForceColor = process.env.FORCE_COLOR;
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
});

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = savedForceColor;
});

function makeEvent<T extends PipelineEvent['event']>(
  event: T,
  partial: Partial<Extract<PipelineEvent, { event: T }>>,
): PipelineEvent {
  return {
    ts: '2026-05-18T00:00:00Z',
    sequence: 1,
    runId: 'run-abcdef0123456789',
    event,
    ...partial,
  } as PipelineEvent;
}

describe('renderWatchEvent — no color', () => {
  test('phase_start uses formatPhaseHeader output (60 chars wide)', () => {
    const out = renderWatchEvent(makeEvent('phase_start', { phase: 'implement', agent: 'implementer' } as any));
    expect(out.startsWith('▶ implement (implementer)')).toBe(true);
    expect(out.length).toBe(60);
    expect(out.includes('─')).toBe(true);
  });

  test('phase_end completed uses ✓ and padded duration', () => {
    const out = renderWatchEvent(
      makeEvent('phase_end', {
        phase: 'verify',
        agent: 'verifier',
        outcome: 'completed',
        durationMs: 42_000,
      } as any),
    );
    expect(out.startsWith('✓ verify completed')).toBe(true);
    expect(out.endsWith('42s')).toBe(true);
  });

  test('phase_end failed uses ✗', () => {
    const out = renderWatchEvent(
      makeEvent('phase_end', {
        phase: 'review',
        agent: 'reviewer',
        outcome: 'failed',
        durationMs: 18_000,
      } as any),
    );
    expect(out.startsWith('✗ review failed')).toBe(true);
    expect(out.endsWith('18s')).toBe(true);
  });

  test('phase_end skipped uses ⊘', () => {
    const out = renderWatchEvent(
      makeEvent('phase_end', {
        phase: 'verify',
        agent: 'verifier',
        outcome: 'skipped',
        durationMs: 0,
      } as any),
    );
    expect(out).toBe('⊘ verify skipped');
  });

  test('tool_start renders as indented tool line', () => {
    const out = renderWatchEvent(
      makeEvent('tool_start', {
        phase: 'implement',
        agent: 'implementer',
        toolCallId: 't1',
        tool: 'Read',
        args: 'src/foo.ts',
      } as any),
    );
    expect(out).toBe('    ↳ Read src/foo.ts');
  });

  test('tool_end renders with duration', () => {
    const out = renderWatchEvent(
      makeEvent('tool_end', {
        phase: 'implement',
        agent: 'implementer',
        toolCallId: 't1',
        tool: 'Read',
        durationMs: 2_000,
        isError: false,
        result: 'ok',
      } as any),
    );
    expect(out.startsWith('    ↳ Read')).toBe(true);
    expect(out.endsWith('2s')).toBe(true);
  });

  test('tool_end with error appends ERROR marker', () => {
    const out = renderWatchEvent(
      makeEvent('tool_end', {
        phase: 'implement',
        agent: 'implementer',
        toolCallId: 't1',
        tool: 'Bash',
        durationMs: 1_000,
        isError: true,
        result: 'failed',
      } as any),
    );
    expect(out.includes('ERROR')).toBe(true);
  });

  test('revision_requested', () => {
    const out = renderWatchEvent(
      makeEvent('revision_requested', { source: 'verifier', cycle: 1, failedCategories: [] } as any),
    );
    expect(out).toBe('↻ revision requested by verifier (cycle 1)');
  });

  test('revision_budget_exhausted', () => {
    const out = renderWatchEvent(makeEvent('revision_budget_exhausted', { cycles: 2 } as any));
    expect(out).toBe('⚠ revision budget exhausted (2 cycles)');
  });

  test('status_changed shows new status', () => {
    const out = renderWatchEvent(makeEvent('status_changed', { from: 'implementing', to: 'evaluating' } as any));
    expect(out).toBe('→ evaluating');
  });

  test('pipeline_start shows profile + short runId', () => {
    const out = renderWatchEvent(
      makeEvent('pipeline_start', {
        taskId: 'task-1',
        profile: 'standard',
        plan: {} as any,
        runId: 'abcdef0123456789xyz',
      } as any),
    );
    expect(out.startsWith('▶ pipeline started (standard profile, run ')).toBe(true);
    expect(out.includes('abcdef01')).toBe(true);
  });

  test('pipeline_end completed', () => {
    const out = renderWatchEvent(makeEvent('pipeline_end', { outcome: 'completed', durationMs: 222_000 } as any));
    expect(out).toBe('✓ pipeline complete (3m 42s)');
  });

  test('pipeline_end failed', () => {
    const out = renderWatchEvent(
      makeEvent('pipeline_end', { outcome: 'failed', failedAgent: 'reviewer', durationMs: 135_000 } as any),
    );
    expect(out).toBe('✗ pipeline failed at reviewer (2m 15s)');
  });

  test('marker_written', () => {
    const out = renderWatchEvent(makeEvent('marker_written', { marker: '.case-tested', path: '/tmp/x' } as any));
    expect(out).toBe('📎 marker: .case-tested');
  });
});

describe('renderWatchEvent — with color (FORCE_COLOR)', () => {
  beforeEach(() => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
  });

  test('phase_end completed icon is green', () => {
    const out = renderWatchEvent(
      makeEvent('phase_end', {
        phase: 'verify',
        agent: 'verifier',
        outcome: 'completed',
        durationMs: 5_000,
      } as any),
    );
    expect(out.startsWith('\x1b[32m✓\x1b[0m')).toBe(true);
  });

  test('phase_end failed icon is red', () => {
    const out = renderWatchEvent(
      makeEvent('phase_end', {
        phase: 'verify',
        agent: 'verifier',
        outcome: 'failed',
        durationMs: 5_000,
      } as any),
    );
    expect(out.startsWith('\x1b[31m✗\x1b[0m')).toBe(true);
  });

  test('pipeline_end completed is green', () => {
    const out = renderWatchEvent(makeEvent('pipeline_end', { outcome: 'completed', durationMs: 5_000 } as any));
    expect(out.startsWith('\x1b[32m')).toBe(true);
  });

  test('pipeline_end failed is red', () => {
    const out = renderWatchEvent(
      makeEvent('pipeline_end', { outcome: 'failed', failedAgent: 'reviewer', durationMs: 5_000 } as any),
    );
    expect(out.startsWith('\x1b[31m')).toBe(true);
  });

  test('revision_requested is yellow', () => {
    const out = renderWatchEvent(
      makeEvent('revision_requested', { source: 'verifier', cycle: 1, failedCategories: [] } as any),
    );
    expect(out.startsWith('\x1b[33m')).toBe(true);
  });

  test('tool_start is dim', () => {
    const out = renderWatchEvent(
      makeEvent('tool_start', {
        phase: 'implement',
        agent: 'implementer',
        toolCallId: 't1',
        tool: 'Read',
        args: 'src/foo.ts',
      } as any),
    );
    expect(out.startsWith('\x1b[2m')).toBe(true);
  });
});
