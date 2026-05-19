import { describe, test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ALL_OUTCOMES,
  ALL_PHASES,
  applicableOutcomes,
  listMatrixKeys,
  resolveOutcome,
  UnknownOutcomeError,
} from '../dag/outcome-table.js';
import type { OutcomeKind, PhaseName } from '../types.js';

describe('outcome matrix — exhaustiveness', () => {
  for (const phase of ALL_PHASES) {
    for (const outcome of applicableOutcomes(phase)) {
      test(`${phase}:${outcome} has a defined action`, () => {
        const action = resolveOutcome(phase, outcome);
        expect(action).toBeDefined();
        expect(typeof action.action).toBe('string');
      });
    }
  }
});

describe('outcome matrix — rejection of invalid combinations', () => {
  test('throws UnknownOutcomeError for non-applicable (phase, outcome) pairs', () => {
    // `fail-github-unreachable` should only apply to `close`.
    expect(() => resolveOutcome('implement', 'fail-github-unreachable')).toThrow(UnknownOutcomeError);
    expect(() => resolveOutcome('verify', 'fail-github-unreachable')).toThrow(UnknownOutcomeError);
    expect(() => resolveOutcome('review', 'fail-github-unreachable')).toThrow(UnknownOutcomeError);
  });

  test('throws UnknownOutcomeError for outcomes not registered for a phase', () => {
    // `fail-no-code-changes` should be implement-only.
    expect(() => resolveOutcome('verify', 'fail-no-code-changes')).toThrow(UnknownOutcomeError);
    expect(() => resolveOutcome('review', 'fail-no-code-changes')).toThrow(UnknownOutcomeError);
    expect(() => resolveOutcome('close', 'fail-no-code-changes')).toThrow(UnknownOutcomeError);
  });

  test('UnknownOutcomeError carries phase and outcome context', () => {
    try {
      resolveOutcome('verify', 'fail-github-unreachable');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownOutcomeError);
      const e = err as UnknownOutcomeError;
      expect(e.phase).toBe('verify');
      expect(e.outcome).toBe('fail-github-unreachable');
      expect(e.message).toContain('verify');
      expect(e.message).toContain('fail-github-unreachable');
    }
  });

  test('matrix contains no entries for non-applicable pairs', () => {
    const applicableSet = new Set<string>();
    for (const phase of ALL_PHASES) {
      for (const outcome of applicableOutcomes(phase)) {
        applicableSet.add(`${phase}:${outcome}`);
      }
    }

    for (const key of listMatrixKeys()) {
      expect(applicableSet.has(key)).toBe(true);
    }
  });

  test('every (phase, outcome) cartesian product is either applicable+defined or rejected', () => {
    for (const phase of ALL_PHASES) {
      const applicable = new Set(applicableOutcomes(phase));
      for (const outcome of ALL_OUTCOMES) {
        if (applicable.has(outcome)) {
          expect(() => resolveOutcome(phase, outcome)).not.toThrow();
        } else {
          expect(() => resolveOutcome(phase, outcome)).toThrow(UnknownOutcomeError);
        }
      }
    }
  });
});

describe('outcome matrix — key entries', () => {
  test('implement:success advances to verify', () => {
    const action = resolveOutcome('implement', 'success');
    expect(action.action).toBe('advance');
    if (action.action === 'advance') {
      expect(action.to).toBe('verify');
    }
  });

  test('implement:fail-no-code-changes aborts (do not verify text-only output)', () => {
    const action = resolveOutcome('implement', 'fail-no-code-changes');
    expect(action.action).toBe('abort');
    if (action.action === 'abort') {
      expect(action.reason).toContain('no code changes');
    }
  });

  test('implement:fail-test triggers retry with bounded attempts', () => {
    const action = resolveOutcome('implement', 'fail-test');
    expect(action.action).toBe('retry');
    if (action.action === 'retry') {
      expect(action.maxAttempts).toBeGreaterThan(0);
    }
  });

  test('verify:fail-test requests a revision cycle', () => {
    const action = resolveOutcome('verify', 'fail-test');
    expect(action.action).toBe('revision');
    if (action.action === 'revision') {
      expect(action.cycle).toBe('next');
    }
  });

  test('verify:fail-evidence-missing requests a revision cycle', () => {
    const action = resolveOutcome('verify', 'fail-evidence-missing');
    expect(action.action).toBe('revision');
  });

  test('review:success advances to close', () => {
    const action = resolveOutcome('review', 'success');
    expect(action.action).toBe('advance');
    if (action.action === 'advance') {
      expect(action.to).toBe('close');
    }
  });

  test('review:fail-critical-findings aborts the pipeline', () => {
    const action = resolveOutcome('review', 'fail-critical-findings');
    expect(action.action).toBe('abort');
  });

  test('review:fail-soft-findings requests a revision cycle', () => {
    const action = resolveOutcome('review', 'fail-soft-findings');
    expect(action.action).toBe('revision');
  });

  test('review:budget-exhausted skips to close with warning', () => {
    const action = resolveOutcome('review', 'budget-exhausted');
    expect(action.action).toBe('skip-to');
    if (action.action === 'skip-to') {
      expect(action.to).toBe('close');
      expect(action.withWarning.length).toBeGreaterThan(0);
    }
  });

  test('close:success advances to retrospective', () => {
    const action = resolveOutcome('close', 'success');
    expect(action.action).toBe('advance');
    if (action.action === 'advance') {
      expect(action.to).toBe('retrospective');
    }
  });

  test('close:fail-github-unreachable retries once', () => {
    const action = resolveOutcome('close', 'fail-github-unreachable');
    expect(action.action).toBe('retry');
    if (action.action === 'retry') {
      expect(action.maxAttempts).toBe(1);
    }
  });

  test('close:fail-agent-protocol surfaces to a human', () => {
    const action = resolveOutcome('close', 'fail-agent-protocol');
    expect(action.action).toBe('surface');
    if (action.action === 'surface') {
      expect(action.message.length).toBeGreaterThan(0);
    }
  });

  test('retrospective never blocks: success advances to complete', () => {
    const action = resolveOutcome('retrospective', 'success');
    expect(action.action).toBe('advance');
    if (action.action === 'advance') {
      expect(action.to).toBe('complete');
    }
  });

  test('retrospective:fail-timeout skips to complete (never blocks pipeline)', () => {
    const action = resolveOutcome('retrospective', 'fail-timeout');
    expect(action.action).toBe('skip-to');
    if (action.action === 'skip-to') {
      expect(action.to).toBe('complete');
    }
  });

  test('retrospective:fail-agent-protocol skips to complete (never blocks pipeline)', () => {
    const action = resolveOutcome('retrospective', 'fail-agent-protocol');
    expect(action.action).toBe('skip-to');
    if (action.action === 'skip-to') {
      expect(action.to).toBe('complete');
    }
  });
});

describe('outcome matrix — abort-user surface', () => {
  // Every phase that runs an agent must support an explicit user abort.
  const phasesWithUserAbort: PhaseName[] = ['implement', 'verify', 'review', 'close'];
  for (const phase of phasesWithUserAbort) {
    test(`${phase}:abort-user resolves to abort`, () => {
      const action = resolveOutcome(phase, 'abort-user');
      expect(action.action).toBe('abort');
    });
  }
});

describe('outcome matrix — doc/code drift detection', () => {
  test('docs/failure-matrix.md mentions every matrix key', async () => {
    const docPath = resolve(import.meta.dir, '../../docs/failure-matrix.md');
    const md = await readFile(docPath, 'utf8');

    for (const key of listMatrixKeys()) {
      const [phase, outcome] = key.split(':') as [PhaseName, OutcomeKind];
      // The doc uses `phase:` headers and `outcome` cells; assert both appear.
      // We do not require the exact `phase:outcome` string — the table rows
      // separate phase (section header) from outcome (first column).
      expect(md).toContain(outcome);
      expect(md.toLowerCase()).toContain(`phase: ${phase}`);
    }
  });

  test('docs/failure-matrix.md points at the canonical TS module', async () => {
    const docPath = resolve(import.meta.dir, '../../docs/failure-matrix.md');
    const md = await readFile(docPath, 'utf8');
    expect(md).toContain('src/dag/outcome-table.ts');
  });
});

describe('outcome matrix — coverage sanity', () => {
  test('every declared OutcomeKind is applicable to at least one phase', () => {
    const seen = new Set<OutcomeKind>();
    for (const phase of ALL_PHASES) {
      for (const outcome of applicableOutcomes(phase)) {
        seen.add(outcome);
      }
    }
    for (const outcome of ALL_OUTCOMES) {
      expect(seen.has(outcome)).toBe(true);
    }
  });

  test('every phase has at least one applicable outcome (including success)', () => {
    for (const phase of ALL_PHASES) {
      const outcomes = applicableOutcomes(phase);
      expect(outcomes.length).toBeGreaterThan(0);
      expect(outcomes).toContain('success' as OutcomeKind);
    }
  });
});
