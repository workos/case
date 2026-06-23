import { describe, it, expect } from 'vitest';
import { detectArgumentType, fetchIssue } from '../entry/issue-fetcher.js';

describe('detectArgumentType', () => {
  it('classifies pure digits as github', () => {
    expect(detectArgumentType('123')).toBe('github');
  });

  it('classifies UPPER-N as linear', () => {
    expect(detectArgumentType('ENG-456')).toBe('linear');
  });

  it('classifies anything else as freeform', () => {
    expect(detectArgumentType('td-4854df')).toBe('freeform');
    expect(detectArgumentType('fix the login flow')).toBe('freeform');
  });
});

describe('fetchIssue (freeform)', () => {
  it('pads a short freeform title to satisfy td minimum length', async () => {
    const ctx = await fetchIssue('freeform', 'td-4854df');
    expect(ctx.issueType).toBe('freeform');
    expect(ctx.title.length).toBeGreaterThanOrEqual(15);
    expect(ctx.title).toBe('Freeform task: td-4854df');
    // Body preserves the raw text verbatim.
    expect(ctx.body).toBe('td-4854df');
    // Branch slug is derived from the raw text, not the padded title.
    expect(ctx.issueNumber).toBe('td-4854df');
  });

  it('leaves a sufficiently long freeform title unchanged', async () => {
    const text = 'fix the login flow timeout';
    const ctx = await fetchIssue('freeform', text);
    expect(ctx.title).toBe(text);
    expect(ctx.body).toBe(text);
  });
});
