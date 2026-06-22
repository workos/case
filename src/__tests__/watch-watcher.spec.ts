import { describe, test, expect } from 'bun:test';
import type { Langfuse } from 'langfuse';
import { watchTrace, type WatchRecord, type WatchOptions } from '../watch/watcher.js';
import type { Observation, TraceDetails } from '../tracing/readback.js';

/**
 * Phase 2.2 — `ca watch` reads the run's Langfuse trace (load + poll-with-cursor)
 * instead of tailing a JSONL log. These drive the generator over a fake read
 * client returning canned trace snapshots and assert the emitted WatchRecords.
 */

function obs(o: Partial<Observation> & { id: string; type: string }): Observation {
  return { startTime: '2026-01-01T00:00:00.000Z', ...o } as Observation;
}

/** A fake read client: traceList resolves the id; traceGet walks the snapshot list. */
function fakeClient(snapshots: TraceDetails[], opts: { noTrace?: boolean } = {}): Langfuse {
  let i = 0;
  return {
    api: {
      traceList: async () => ({ data: opts.noTrace ? [] : [{ id: 'r1' }] }),
      traceGet: async () => snapshots[Math.min(i++, snapshots.length - 1)],
    },
  } as unknown as Langfuse;
}

async function collect(options: WatchOptions): Promise<WatchRecord[]> {
  const out: WatchRecord[] = [];
  for await (const r of watchTrace({ pollIntervalMs: 1, maxIdleMs: 40, ...options })) out.push(r);
  return out;
}

const trace = (observations: Observation[], scores: TraceDetails['scores'] = []): TraceDetails => ({
  id: 'r1',
  observations,
  scores,
});

describe('watchTrace', () => {
  test('loads observations and completes when the retrospective span ends', async () => {
    const snapshot = trace([
      obs({
        id: 'a',
        type: 'SPAN',
        name: 'phase:implement',
        startTime: '2026-01-01T00:00:01Z',
        endTime: '2026-01-01T00:00:02Z',
      }),
      obs({
        id: 'b',
        type: 'SPAN',
        name: 'tool:bash',
        startTime: '2026-01-01T00:00:01.5Z',
        endTime: '2026-01-01T00:00:01.8Z',
      }),
      obs({
        id: 'c',
        type: 'SPAN',
        name: 'phase:retrospective',
        startTime: '2026-01-01T00:00:03Z',
        endTime: '2026-01-01T00:00:04Z',
      }),
    ]);

    const records = await collect({ taskSlug: 'task-1', client: fakeClient([snapshot]) });
    const kinds = records.map((r) => r.kind);

    expect(records[0]).toEqual({ kind: 'trace_start', traceId: 'r1', traceName: 'case-run:task-1' });
    expect(kinds).toContain('span_start');
    // span_starts emitted in start-time order
    const starts = records.filter((r): r is Extract<WatchRecord, { kind: 'span_start' }> => r.kind === 'span_start');
    expect(starts.map((s) => s.name)).toEqual(['implement', 'bash', 'retrospective']);
    // completes and stops
    expect(records.at(-1)).toEqual({ kind: 'run_complete' });
  });

  test('pinned runId skips trace resolution and tails that trace', async () => {
    const snapshot = trace([
      obs({
        id: 'a',
        type: 'SPAN',
        name: 'phase:retrospective',
        startTime: '2026-01-01T00:00:03Z',
        endTime: '2026-01-01T00:00:04Z',
      }),
    ]);
    const records = await collect({ taskSlug: 'task-1', runId: 'pinned-run', client: fakeClient([snapshot]) });
    expect(records[0]).toEqual({ kind: 'trace_start', traceId: 'pinned-run', traceName: 'case-run:task-1' });
    expect(records.at(-1)).toEqual({ kind: 'run_complete' });
  });

  test('emits rubric scores', async () => {
    const snapshot = trace(
      [
        obs({
          id: 'a',
          type: 'SPAN',
          name: 'phase:retrospective',
          startTime: '2026-01-01T00:00:03Z',
          endTime: '2026-01-01T00:00:04Z',
        }),
      ],
      [{ name: 'verifier:edge-case', value: 0, comment: 'missing null check' }],
    );
    const records = await collect({ taskSlug: 'task-1', client: fakeClient([snapshot]) });
    const score = records.find((r) => r.kind === 'score');
    expect(score).toEqual({ kind: 'score', name: 'verifier:edge-case', value: 0, comment: 'missing null check' });
  });

  test('raw format surfaces generations; structured hides them', async () => {
    const make = () =>
      trace([
        obs({ id: 'g', type: 'GENERATION', name: 'turn', usageDetails: { total: 100 }, costDetails: { total: 0.01 } }),
        obs({
          id: 'r',
          type: 'SPAN',
          name: 'phase:retrospective',
          startTime: '2026-01-01T00:00:03Z',
          endTime: '2026-01-01T00:00:04Z',
        }),
      ]);
    const raw = await collect({ taskSlug: 'task-1', format: 'raw', client: fakeClient([make()]) });
    expect(raw.some((r) => r.kind === 'generation')).toBe(true);

    const structured = await collect({ taskSlug: 'task-1', format: 'structured', client: fakeClient([make()]) });
    expect(structured.some((r) => r.kind === 'generation')).toBe(false);
  });

  test('returns when no trace ever appears', async () => {
    const records = await collect({ taskSlug: 'task-1', client: fakeClient([], { noTrace: true }), timeoutMs: 50 });
    expect(records).toEqual([]);
  });

  test('returns on idle when the run goes quiet without a retrospective', async () => {
    const snapshot = trace([
      obs({
        id: 'a',
        type: 'SPAN',
        name: 'phase:implement',
        startTime: '2026-01-01T00:00:01Z',
        endTime: '2026-01-01T00:00:02Z',
      }),
    ]);
    const records = await collect({ taskSlug: 'task-1', client: fakeClient([snapshot]) });
    expect(records.some((r) => r.kind === 'span_start')).toBe(true);
    expect(records.some((r) => r.kind === 'run_complete')).toBe(false);
  });
});
