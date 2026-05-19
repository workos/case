import { describe, expect, test } from 'bun:test';
import { FINGERPRINT_LENGTH, computeFingerprint, fingerprintsMatch } from '../dag/fingerprint.js';

describe('computeFingerprint', () => {
  test('produces a 16-char hex string', () => {
    const fp = computeFingerprint({
      failedCategories: ['reproduced-scenario'],
      errorSummary: 'test failed',
    });
    expect(fp).toHaveLength(FINGERPRINT_LENGTH);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  test('identical inputs produce identical fingerprints', () => {
    const a = computeFingerprint({
      failedCategories: ['reproduced-scenario', 'exercised-changed-path'],
      errorSummary: 'expected pass, got fail',
    });
    const b = computeFingerprint({
      failedCategories: ['reproduced-scenario', 'exercised-changed-path'],
      errorSummary: 'expected pass, got fail',
    });
    expect(a).toBe(b);
  });

  test('different failedCategories produce different fingerprints', () => {
    const a = computeFingerprint({
      failedCategories: ['reproduced-scenario'],
      errorSummary: 'test failed',
    });
    const b = computeFingerprint({
      failedCategories: ['principle-compliance'],
      errorSummary: 'test failed',
    });
    expect(a).not.toBe(b);
  });

  test('category order does not affect the fingerprint (sort normalization)', () => {
    const a = computeFingerprint({
      failedCategories: ['reproduced-scenario', 'exercised-changed-path'],
      errorSummary: 'same summary',
    });
    const b = computeFingerprint({
      failedCategories: ['exercised-changed-path', 'reproduced-scenario'],
      errorSummary: 'same summary',
    });
    expect(a).toBe(b);
  });

  test('whitespace differences in errorSummary do not affect the fingerprint', () => {
    const a = computeFingerprint({
      failedCategories: ['reproduced-scenario'],
      errorSummary: 'test failed',
    });
    const b = computeFingerprint({
      failedCategories: ['reproduced-scenario'],
      errorSummary: '  test failed  ',
    });
    expect(a).toBe(b);
  });

  test('case differences in errorSummary do not affect the fingerprint', () => {
    const a = computeFingerprint({
      failedCategories: ['reproduced-scenario'],
      errorSummary: 'Test Failed',
    });
    const b = computeFingerprint({
      failedCategories: ['reproduced-scenario'],
      errorSummary: 'test failed',
    });
    expect(a).toBe(b);
  });

  test('empty categories list produces a valid fingerprint', () => {
    const fp = computeFingerprint({
      failedCategories: [],
      errorSummary: 'something broke',
    });
    expect(fp).toHaveLength(FINGERPRINT_LENGTH);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  test('empty errorSummary produces a valid fingerprint', () => {
    const fp = computeFingerprint({
      failedCategories: ['reproduced-scenario'],
      errorSummary: '',
    });
    expect(fp).toHaveLength(FINGERPRINT_LENGTH);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  test('single-character difference in errorSummary produces a different fingerprint', () => {
    const a = computeFingerprint({
      failedCategories: ['reproduced-scenario'],
      errorSummary: 'test failed at line 42',
    });
    const b = computeFingerprint({
      failedCategories: ['reproduced-scenario'],
      errorSummary: 'test failed at line 43',
    });
    expect(a).not.toBe(b);
  });

  test('does not mutate the input categories array', () => {
    const categories = ['z-category', 'a-category', 'm-category'];
    const snapshot = [...categories];
    computeFingerprint({ failedCategories: categories, errorSummary: 'x' });
    expect(categories).toEqual(snapshot);
  });

  test('deterministic across many invocations', () => {
    const input = {
      failedCategories: ['reproduced-scenario', 'pattern-fit'],
      errorSummary: 'flaky test',
    };
    const first = computeFingerprint(input);
    for (let i = 0; i < 50; i++) {
      expect(computeFingerprint(input)).toBe(first);
    }
  });
});

describe('fingerprintsMatch', () => {
  test('returns true for identical fingerprints', () => {
    expect(fingerprintsMatch('abc123', 'abc123')).toBe(true);
  });

  test('returns false for different fingerprints', () => {
    expect(fingerprintsMatch('abc123', 'def456')).toBe(false);
  });

  test('integrates with computeFingerprint — same input matches', () => {
    const a = computeFingerprint({ failedCategories: ['x'], errorSummary: 'y' });
    const b = computeFingerprint({ failedCategories: ['x'], errorSummary: 'y' });
    expect(fingerprintsMatch(a, b)).toBe(true);
  });

  test('integrates with computeFingerprint — different input does not match', () => {
    const a = computeFingerprint({ failedCategories: ['x'], errorSummary: 'y' });
    const b = computeFingerprint({ failedCategories: ['x'], errorSummary: 'z' });
    expect(fingerprintsMatch(a, b)).toBe(false);
  });

  test('empty strings match', () => {
    expect(fingerprintsMatch('', '')).toBe(true);
  });
});
