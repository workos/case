import { describe, test, expect } from 'bun:test';
import { mergeRevisionRequests } from '../dag/merge.js';
import type { RevisionRequest } from '../types.js';

describe('mergeRevisionRequests', () => {
  test('single request returns as-is', () => {
    const req: RevisionRequest = {
      source: 'verifier',
      failedCategories: [{ category: 'reproduced-scenario', verdict: 'fail', detail: 'test not reproduced' }],
      summary: 'Tests not reproduced',
      suggestedFocus: ['src/foo.ts'],
      cycle: 1,
    };
    expect(mergeRevisionRequests([req])).toEqual(req);
  });

  test('merges two sources with combined categories', () => {
    const req1: RevisionRequest = {
      source: 'verifier',
      failedCategories: [{ category: 'reproduced-scenario', verdict: 'fail', detail: 'no test' }],
      summary: 'Verification failed',
      suggestedFocus: ['src/a.ts'],
      cycle: 1,
    };
    const req2: RevisionRequest = {
      source: 'reviewer',
      failedCategories: [{ category: 'principle-compliance', verdict: 'fail', detail: 'wrong pattern' }],
      summary: 'Review failed',
      suggestedFocus: ['src/b.ts'],
      cycle: 1,
    };
    const merged = mergeRevisionRequests([req1, req2]);

    expect(merged.failedCategories).toHaveLength(2);
    expect(merged.failedCategories.map((c) => c.category)).toEqual(['reproduced-scenario', 'principle-compliance']);
    expect(merged.suggestedFocus).toEqual(['src/a.ts', 'src/b.ts']);
    expect(merged.summary).toContain('[verifier]');
    expect(merged.summary).toContain('[reviewer]');
  });

  test('deduplicates categories by name', () => {
    const req1: RevisionRequest = {
      source: 'verifier',
      failedCategories: [{ category: 'edge-case-checked', verdict: 'fail', detail: 'from verifier' }],
      summary: 'a',
      suggestedFocus: [],
      cycle: 1,
    };
    const req2: RevisionRequest = {
      source: 'reviewer',
      failedCategories: [{ category: 'edge-case-checked', verdict: 'fail', detail: 'from reviewer' }],
      summary: 'b',
      suggestedFocus: [],
      cycle: 1,
    };
    const merged = mergeRevisionRequests([req1, req2]);
    expect(merged.failedCategories).toHaveLength(1);
    expect(merged.failedCategories[0].detail).toBe('from verifier');
  });

  test('unions suggestedFocus and deduplicates', () => {
    const req1: RevisionRequest = {
      source: 'verifier',
      failedCategories: [],
      summary: 'a',
      suggestedFocus: ['src/x.ts', 'src/y.ts'],
      cycle: 1,
    };
    const req2: RevisionRequest = {
      source: 'reviewer',
      failedCategories: [],
      summary: 'b',
      suggestedFocus: ['src/y.ts', 'src/z.ts'],
      cycle: 1,
    };
    const merged = mergeRevisionRequests([req1, req2]);
    expect(merged.suggestedFocus).toEqual(['src/x.ts', 'src/y.ts', 'src/z.ts']);
  });

  test('takes max cycle', () => {
    const req1: RevisionRequest = {
      source: 'verifier',
      failedCategories: [],
      summary: 'a',
      suggestedFocus: [],
      cycle: 1,
    };
    const req2: RevisionRequest = {
      source: 'reviewer',
      failedCategories: [],
      summary: 'b',
      suggestedFocus: [],
      cycle: 2,
    };
    expect(mergeRevisionRequests([req1, req2]).cycle).toBe(2);
  });

  test('single source preserves original source field', () => {
    const req1: RevisionRequest = {
      source: 'reviewer',
      failedCategories: [],
      summary: 'a',
      suggestedFocus: [],
      cycle: 1,
    };
    const req2: RevisionRequest = {
      source: 'reviewer',
      failedCategories: [],
      summary: 'b',
      suggestedFocus: [],
      cycle: 1,
    };
    expect(mergeRevisionRequests([req1, req2]).source).toBe('reviewer');
  });

  test('throws on empty array', () => {
    expect(() => mergeRevisionRequests([])).toThrow();
  });
});
