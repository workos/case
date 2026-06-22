import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { renderWatchEvent } from '../watch/renderer.js';
import type { WatchRecord } from '../watch/watcher.js';

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

describe('renderWatchEvent — no color', () => {
  test('trace_start shows trace name + short id', () => {
    const out = renderWatchEvent({ kind: 'trace_start', traceId: 'abcdef0123456789', traceName: 'case-run:task-1' });
    expect(out).toBe('▶ watching case-run:task-1 (trace abcdef01)');
  });

  test('phase span_start', () => {
    expect(renderWatchEvent({ kind: 'span_start', span: 'phase', name: 'implement' })).toBe('▶ implement');
  });

  test('tool span_start is indented', () => {
    expect(renderWatchEvent({ kind: 'span_start', span: 'tool', name: 'bash' })).toBe('  ⚙ bash');
  });

  test('phase span_end completed uses ✓ + duration', () => {
    const out = renderWatchEvent({
      kind: 'span_end',
      span: 'phase',
      name: 'verify',
      durationMs: 42_000,
      isError: false,
    });
    expect(out).toBe('✓ verify (42s)');
  });

  test('phase span_end error uses ✗', () => {
    const out = renderWatchEvent({
      kind: 'span_end',
      span: 'phase',
      name: 'review',
      durationMs: 18_000,
      isError: true,
    });
    expect(out).toBe('✗ review (18s)');
  });

  test('tool span_end with error appends ERROR', () => {
    const out = renderWatchEvent({ kind: 'span_end', span: 'tool', name: 'bash', durationMs: 1_000, isError: true });
    expect(out.includes('ERROR')).toBe(true);
  });

  test('generation shows tokens + cost', () => {
    const out = renderWatchEvent({ kind: 'generation', model: 'claude', tokens: 1234, cost: 0.0021 });
    expect(out).toBe('  ↳ turn claude (1234 tok, $0.0021)');
  });

  test('event renders the domain name', () => {
    expect(renderWatchEvent({ kind: 'event', name: 'revision_requested' })).toBe('↻ revision_requested');
  });

  test('score renders name + value + comment', () => {
    const out = renderWatchEvent({
      kind: 'score',
      name: 'verifier:edge-case',
      value: 0,
      comment: 'missing null check',
    });
    expect(out).toBe('★ verifier:edge-case: 0 — missing null check');
  });

  test('run_complete', () => {
    expect(renderWatchEvent({ kind: 'run_complete' })).toBe('✓ run complete');
  });
});

describe('renderWatchEvent — with color (FORCE_COLOR)', () => {
  beforeEach(() => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
  });

  test('phase span_end completed icon is green', () => {
    const out = renderWatchEvent({
      kind: 'span_end',
      span: 'phase',
      name: 'verify',
      durationMs: 5_000,
      isError: false,
    });
    expect(out.startsWith('\x1b[32m')).toBe(true);
  });

  test('phase span_end error is red', () => {
    const out = renderWatchEvent({ kind: 'span_end', span: 'phase', name: 'verify', durationMs: 5_000, isError: true });
    expect(out.startsWith('\x1b[31m')).toBe(true);
  });

  test('event is yellow', () => {
    expect(renderWatchEvent({ kind: 'event', name: 'fingerprint_match' }).startsWith('\x1b[33m')).toBe(true);
  });

  test('tool span_start is dim', () => {
    expect(renderWatchEvent({ kind: 'span_start', span: 'tool', name: 'bash' }).startsWith('\x1b[2m')).toBe(true);
  });
});
