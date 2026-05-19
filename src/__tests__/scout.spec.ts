import { describe, it, expect } from 'bun:test';
import {
  parseScoutFindings,
  ScoutFindingsValidationError,
  synthesizeForImplementer,
  validateScoutFindings,
} from '../scout/findings.js';
import type { ScoutFindings } from '../types.js';

function makeFindings(overrides: Partial<ScoutFindings> = {}): ScoutFindings {
  return {
    relevantFiles: [
      { path: 'src/dag/builder.ts', reason: 'wires phases into the graph' },
      { path: 'src/phases/verify.ts', reason: 'mirror its read-only phase pattern' },
    ],
    patterns: [
      {
        name: 'phase-dispatch',
        file: 'src/phases/verify.ts',
        description: 'phases return PhaseOutput with nextPhase + outcome',
      },
    ],
    testBaseline: {
      command: 'bun test ./src/__tests__/',
      passing: 590,
      failing: 0,
      relevant: ['src/__tests__/dag-builder.spec.ts'],
    },
    constraints: ['No new runtime dependencies without owner approval'],
    suggestedApproach: 'Mirror verifier.md — read-only agent + structured AGENT_RESULT.',
    ...overrides,
  };
}

describe('validateScoutFindings', () => {
  it('accepts a well-formed payload', () => {
    const findings = makeFindings();
    expect(validateScoutFindings(findings)).toEqual(findings);
  });

  it('accepts findings without optional fields', () => {
    const minimal: ScoutFindings = {
      relevantFiles: [],
      patterns: [],
      constraints: [],
    };
    const out = validateScoutFindings(minimal);
    expect(out).toEqual(minimal);
    expect(out.testBaseline).toBeUndefined();
    expect(out.suggestedApproach).toBeUndefined();
  });

  it('rejects null or array top-level values', () => {
    expect(() => validateScoutFindings(null)).toThrow(ScoutFindingsValidationError);
    expect(() => validateScoutFindings([])).toThrow(ScoutFindingsValidationError);
    expect(() => validateScoutFindings('hello')).toThrow(ScoutFindingsValidationError);
  });

  it('rejects missing required arrays', () => {
    expect(() => validateScoutFindings({ patterns: [], constraints: [] })).toThrow(/relevantFiles/);
    expect(() => validateScoutFindings({ relevantFiles: [], constraints: [] })).toThrow(/patterns/);
    expect(() => validateScoutFindings({ relevantFiles: [], patterns: [] })).toThrow(/constraints/);
  });

  it('rejects malformed relevantFiles entries', () => {
    const bad = { relevantFiles: [{ path: 'src/a.ts' }], patterns: [], constraints: [] };
    expect(() => validateScoutFindings(bad)).toThrow(/relevantFiles\[0\]\.reason/);
  });

  it('rejects malformed patterns entries', () => {
    const bad = {
      relevantFiles: [],
      patterns: [{ name: 'x', file: 'src/a.ts' }],
      constraints: [],
    };
    expect(() => validateScoutFindings(bad)).toThrow(/patterns\[0\]\.description/);
  });

  it('rejects non-string constraints', () => {
    const bad = { relevantFiles: [], patterns: [], constraints: ['ok', 42] };
    expect(() => validateScoutFindings(bad)).toThrow(/constraints\[1\]/);
  });

  it('rejects malformed testBaseline', () => {
    const bad = {
      relevantFiles: [],
      patterns: [],
      constraints: [],
      testBaseline: { command: 'bun test', passing: 'lots', failing: 0, relevant: [] },
    };
    expect(() => validateScoutFindings(bad)).toThrow(/testBaseline\.passing/);
  });

  it('ignores unknown top-level fields', () => {
    const withExtras = { ...makeFindings(), unexpected: 'value', another: [1, 2, 3] };
    const out = validateScoutFindings(withExtras);
    expect((out as unknown as Record<string, unknown>).unexpected).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).another).toBeUndefined();
  });
});

describe('parseScoutFindings', () => {
  it('returns null on invalid input (graceful degradation)', () => {
    expect(parseScoutFindings(null)).toBeNull();
    expect(parseScoutFindings(undefined)).toBeNull();
    expect(parseScoutFindings({ relevantFiles: 'oops' })).toBeNull();
  });

  it('returns validated findings on valid input', () => {
    const findings = makeFindings();
    expect(parseScoutFindings(findings)).toEqual(findings);
  });
});

describe('synthesizeForImplementer', () => {
  it('produces a "no findings" message when given null', () => {
    const out = synthesizeForImplementer(null);
    expect(out).toContain('## Scout Findings');
    expect(out).toContain('No scout findings available');
  });

  it('produces a "no findings" message when given an empty-but-valid findings object', () => {
    const empty: ScoutFindings = { relevantFiles: [], patterns: [], constraints: [] };
    const out = synthesizeForImplementer(empty);
    expect(out).toContain('## Scout Findings');
    expect(out).toContain('No scout findings');
  });

  it('renders all sections when every field is populated', () => {
    const out = synthesizeForImplementer(makeFindings());
    expect(out).toContain('## Scout Findings');
    expect(out).toContain('### Relevant Files');
    expect(out).toContain('src/dag/builder.ts');
    expect(out).toContain('wires phases into the graph');
    expect(out).toContain('### Patterns to Follow');
    expect(out).toContain('phase-dispatch');
    expect(out).toContain('### Test Baseline');
    expect(out).toContain('Passing: 590');
    expect(out).toContain('### Constraints');
    expect(out).toContain('No new runtime dependencies');
    expect(out).toContain('### Suggested Approach');
    expect(out).toContain('Mirror verifier.md');
  });

  it('omits sections that have no entries', () => {
    const partial = makeFindings({
      patterns: [],
      constraints: [],
      suggestedApproach: undefined,
      testBaseline: undefined,
    });
    const out = synthesizeForImplementer(partial);
    expect(out).toContain('### Relevant Files');
    expect(out).not.toContain('### Patterns to Follow');
    expect(out).not.toContain('### Constraints');
    expect(out).not.toContain('### Test Baseline');
    expect(out).not.toContain('### Suggested Approach');
  });

  it('omits suggestedApproach when it is blank whitespace', () => {
    const partial = makeFindings({ suggestedApproach: '   \n  ' });
    const out = synthesizeForImplementer(partial);
    expect(out).not.toContain('### Suggested Approach');
  });

  it('escapes file paths in code fences for legibility', () => {
    const findings = makeFindings({
      relevantFiles: [{ path: 'src/a.ts', reason: 'because' }],
    });
    const out = synthesizeForImplementer(findings);
    expect(out).toContain('`src/a.ts`');
  });

  it('renders test baseline relevant files when present', () => {
    const out = synthesizeForImplementer(makeFindings());
    expect(out).toContain('`src/__tests__/dag-builder.spec.ts`');
  });

  it('skips test baseline relevant line when the list is empty', () => {
    const findings = makeFindings({
      testBaseline: { command: 'bun test', passing: 1, failing: 0, relevant: [] },
    });
    const out = synthesizeForImplementer(findings);
    expect(out).toContain('### Test Baseline');
    expect(out).not.toContain('Relevant: ');
  });
});
