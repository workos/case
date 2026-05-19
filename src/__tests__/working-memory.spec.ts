import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  validateWorkingMemory,
  validateWorkingMemoryUpdate,
  WorkingMemoryValidationError,
  WORKING_MEMORY_VERSION,
} from '../memory/schema.js';
import {
  emptyWorkingMemory,
  mergeWorkingMemory,
  readWorkingMemory,
  workingMemoryPath,
  writeWorkingMemory,
} from '../memory/working-memory.js';
import { formatForImplementer, formatForVerifier, taskSlugFromTaskJsonPath } from '../memory/format.js';
import type { WorkingMemory } from '../types.js';

function makeMemory(overrides: Partial<WorkingMemory> = {}): WorkingMemory {
  return {
    version: WORKING_MEMORY_VERSION,
    updatedAt: '2026-05-19T12:00:00.000Z',
    currentState: 'idle',
    approach: 'exponential backoff',
    filesChanged: ['src/a.ts'],
    errorsSeen: [{ error: 'TypeError', resolution: 'fixed' }],
    approachesTried: [{ approach: 'linear retry', outcome: 'failed', reason: 'rate-limited' }],
    blockers: [],
    ...overrides,
  };
}

describe('validateWorkingMemory', () => {
  it('accepts a well-formed payload', () => {
    const memory = makeMemory();
    expect(validateWorkingMemory(memory)).toEqual(memory);
  });

  it('rejects wrong version', () => {
    expect(() => validateWorkingMemory({ ...makeMemory(), version: 2 })).toThrow(WorkingMemoryValidationError);
  });

  it('rejects missing required fields', () => {
    const bad = { ...makeMemory() } as Record<string, unknown>;
    delete bad.currentState;
    expect(() => validateWorkingMemory(bad)).toThrow(/currentState/);
  });

  it('rejects bad updatedAt format', () => {
    expect(() => validateWorkingMemory({ ...makeMemory(), updatedAt: 'not a date' })).toThrow(/updatedAt/);
  });

  it('rejects invalid error resolution enum', () => {
    const bad = makeMemory({
      errorsSeen: [{ error: 'X', resolution: 'maybe' as 'fixed' }],
    });
    expect(() => validateWorkingMemory(bad)).toThrow(/resolution/);
  });

  it('rejects invalid approach outcome enum', () => {
    const bad = makeMemory({
      approachesTried: [{ approach: 'X', outcome: 'kinda' as 'failed' }],
    });
    expect(() => validateWorkingMemory(bad)).toThrow(/outcome/);
  });

  it('rejects non-string array entries', () => {
    const bad = makeMemory({ filesChanged: ['ok', 123 as unknown as string] });
    expect(() => validateWorkingMemory(bad)).toThrow(/filesChanged\[1\]/);
  });

  it('rejects null and arrays at the top level', () => {
    expect(() => validateWorkingMemory(null)).toThrow();
    expect(() => validateWorkingMemory([])).toThrow();
  });
});

describe('validateWorkingMemoryUpdate', () => {
  it('accepts an empty update', () => {
    expect(validateWorkingMemoryUpdate({})).toEqual({});
  });

  it('accepts a partial update', () => {
    const out = validateWorkingMemoryUpdate({ currentState: 'foo', filesChanged: ['x.ts'] });
    expect(out).toEqual({ currentState: 'foo', filesChanged: ['x.ts'] });
  });

  it('rejects mis-typed partial fields', () => {
    expect(() => validateWorkingMemoryUpdate({ filesChanged: 'not-an-array' })).toThrow(/filesChanged/);
  });

  it('validates nested errorsSeen on partial update', () => {
    expect(() =>
      validateWorkingMemoryUpdate({
        errorsSeen: [{ error: 'X', resolution: 'bogus' as 'fixed' }],
      }),
    ).toThrow(/resolution/);
  });
});

describe('readWorkingMemory / writeWorkingMemory', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'case-wm-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when file does not exist', () => {
    expect(readWorkingMemory(tempDir)).toBeNull();
  });

  it('round-trips a write through read', () => {
    const memory = makeMemory();
    writeWorkingMemory(tempDir, memory);

    const restored = readWorkingMemory(tempDir);
    expect(restored).not.toBeNull();
    expect(restored!.version).toBe(WORKING_MEMORY_VERSION);
    expect(restored!.currentState).toBe('idle');
    expect(restored!.filesChanged).toEqual(['src/a.ts']);
    expect(restored!.errorsSeen).toEqual([{ error: 'TypeError', resolution: 'fixed' }]);
  });

  it('refreshes updatedAt on every write', () => {
    const memory = makeMemory({ updatedAt: '2020-01-01T00:00:00.000Z' });
    writeWorkingMemory(tempDir, memory);
    const restored = readWorkingMemory(tempDir);
    expect(restored!.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(Date.parse(restored!.updatedAt)).toBeGreaterThan(Date.parse('2020-01-02T00:00:00.000Z'));
  });

  it('creates the task directory if missing', () => {
    const nested = resolve(tempDir, 'does/not/exist');
    expect(existsSync(nested)).toBe(false);
    writeWorkingMemory(nested, makeMemory());
    expect(existsSync(workingMemoryPath(nested))).toBe(true);
  });

  it('returns null and logs warning on corrupt JSON', () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(workingMemoryPath(tempDir), '{ not valid json');
    expect(readWorkingMemory(tempDir)).toBeNull();
  });

  it('returns null when file fails schema validation', () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(workingMemoryPath(tempDir), JSON.stringify({ version: 1, garbage: true }));
    expect(readWorkingMemory(tempDir)).toBeNull();
  });

  it('refuses to write invalid memory (schema validation error)', () => {
    const bad = makeMemory();
    // Force a genuinely bad shape: swap an array field for a scalar.
    (bad as unknown as Record<string, unknown>).filesChanged = 'oops';
    expect(() => writeWorkingMemory(tempDir, bad)).toThrow(WorkingMemoryValidationError);
  });
});

describe('mergeWorkingMemory', () => {
  it('appends to array fields', () => {
    const existing = makeMemory({ filesChanged: ['a.ts'], blockers: ['b1'] });
    const merged = mergeWorkingMemory(existing, {
      filesChanged: ['b.ts'],
      blockers: ['b2'],
    });
    expect(merged.filesChanged).toEqual(['a.ts', 'b.ts']);
    expect(merged.blockers).toEqual(['b1', 'b2']);
  });

  it('deduplicates files by identity', () => {
    const existing = makeMemory({ filesChanged: ['a.ts', 'b.ts'] });
    const merged = mergeWorkingMemory(existing, { filesChanged: ['a.ts', 'c.ts'] });
    expect(merged.filesChanged).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('deduplicates approachesTried by approach key, letting updates upgrade outcomes', () => {
    const existing = makeMemory({
      approachesTried: [{ approach: 'linear', outcome: 'failed' }],
    });
    const merged = mergeWorkingMemory(existing, {
      approachesTried: [{ approach: 'linear', outcome: 'success', reason: 'rate limit fixed upstream' }],
    });
    expect(merged.approachesTried).toEqual([
      { approach: 'linear', outcome: 'success', reason: 'rate limit fixed upstream' },
    ]);
  });

  it('deduplicates errorsSeen by error message', () => {
    const existing = makeMemory({
      errorsSeen: [{ error: 'TypeError', resolution: 'unresolved' }],
    });
    const merged = mergeWorkingMemory(existing, {
      errorsSeen: [
        { error: 'TypeError', resolution: 'fixed' },
        { error: 'RangeError', resolution: 'workaround' },
      ],
    });
    expect(merged.errorsSeen).toEqual([
      { error: 'TypeError', resolution: 'fixed' },
      { error: 'RangeError', resolution: 'workaround' },
    ]);
  });

  it('replaces scalar fields', () => {
    const existing = makeMemory({ currentState: 'before', approach: 'A' });
    const merged = mergeWorkingMemory(existing, { currentState: 'after', approach: 'B' });
    expect(merged.currentState).toBe('after');
    expect(merged.approach).toBe('B');
  });

  it('preserves scalar fields when update omits them', () => {
    const existing = makeMemory({ currentState: 'kept', approach: 'kept' });
    const merged = mergeWorkingMemory(existing, { filesChanged: ['new.ts'] });
    expect(merged.currentState).toBe('kept');
    expect(merged.approach).toBe('kept');
  });

  it('does not mutate inputs', () => {
    const existing = makeMemory();
    const before = JSON.stringify(existing);
    mergeWorkingMemory(existing, { filesChanged: ['z.ts'] });
    expect(JSON.stringify(existing)).toBe(before);
  });
});

describe('emptyWorkingMemory', () => {
  it('returns a valid baseline snapshot', () => {
    const empty = emptyWorkingMemory();
    expect(() => validateWorkingMemory(empty)).not.toThrow();
    expect(empty.filesChanged).toEqual([]);
    expect(empty.approachesTried).toEqual([]);
  });
});

describe('formatForImplementer / formatForVerifier', () => {
  it('produces a bullet list, not raw JSON', () => {
    const memory = makeMemory();
    const out = formatForImplementer(memory);
    expect(out).toContain('## Prior Context');
    expect(out).toContain('- **Approach**: exponential backoff');
    expect(out).toContain('- [failed] linear retry — rate-limited');
    expect(out).not.toContain('"version"');
  });

  it('omits empty sections', () => {
    const memory = makeMemory({
      filesChanged: [],
      errorsSeen: [],
      approachesTried: [],
      blockers: [],
    });
    const out = formatForImplementer(memory);
    expect(out).not.toContain('Files touched');
    expect(out).not.toContain('Approaches tried');
    expect(out).not.toContain('Errors seen');
    expect(out).not.toContain('Blockers');
  });

  it('verifier format keeps it focused on files + approach', () => {
    const memory = makeMemory({
      approachesTried: [{ approach: 'linear', outcome: 'failed' }],
    });
    const out = formatForVerifier(memory);
    expect(out).toContain('Implementer approach');
    expect(out).toContain('Files the implementer changed');
    expect(out).not.toContain('Approaches tried');
  });
});

describe('taskSlugFromTaskJsonPath', () => {
  it('strips the .task.json suffix and directory', () => {
    expect(taskSlugFromTaskJsonPath('/repo/.case/tasks/active/foo-1.task.json')).toBe('foo-1');
  });
  it('handles bare basenames', () => {
    expect(taskSlugFromTaskJsonPath('foo-1.task.json')).toBe('foo-1');
  });
});

describe('ca update-memory CLI (handler)', () => {
  let tempCwd: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempCwd = mkdtempSync(join(tmpdir(), 'case-wm-cli-'));
    mkdirSync(join(tempCwd, '.case'), { recursive: true });
    process.chdir(tempCwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempCwd, { recursive: true, force: true });
  });

  it('fails with exit 1 if no active task', async () => {
    const { handler } = await import('../commands/update-memory.js');
    const code = await handler(['--state', 'foo']);
    expect(code).toBe(1);
  });

  it('creates working-memory.json on first call', async () => {
    writeFileSync(join(tempCwd, '.case/active'), 'foo-1');
    const { handler } = await import('../commands/update-memory.js');
    const code = await handler(['--state', 'Starting', '--approach', 'TDD', '--file', 'src/x.ts']);
    expect(code).toBe(0);

    const path = join(tempCwd, '.case/foo-1/working-memory.json');
    expect(existsSync(path)).toBe(true);
    const memory = JSON.parse(readFileSync(path, 'utf-8'));
    expect(memory.currentState).toBe('Starting');
    expect(memory.approach).toBe('TDD');
    expect(memory.filesChanged).toEqual(['src/x.ts']);
    expect(memory.version).toBe(1);
  });

  it('appends to arrays on subsequent calls', async () => {
    writeFileSync(join(tempCwd, '.case/active'), 'foo-1');
    const { handler } = await import('../commands/update-memory.js');

    await handler(['--state', 'A', '--file', 'src/a.ts']);
    await handler(['--file', 'src/b.ts', '--tried', 'first', '--tried-outcome', 'failed']);

    const memory = JSON.parse(readFileSync(join(tempCwd, '.case/foo-1/working-memory.json'), 'utf-8'));
    expect(memory.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
    expect(memory.approachesTried).toEqual([{ approach: 'first', outcome: 'failed' }]);
  });

  it('rejects invalid --error-status with exit 1', async () => {
    writeFileSync(join(tempCwd, '.case/active'), 'foo-1');
    const { handler } = await import('../commands/update-memory.js');
    const code = await handler(['--error', 'X', '--error-status', 'bogus']);
    expect(code).toBe(1);
  });

  it('rejects --error-status without preceding --error', async () => {
    writeFileSync(join(tempCwd, '.case/active'), 'foo-1');
    const { handler } = await import('../commands/update-memory.js');
    const code = await handler(['--error-status', 'fixed']);
    expect(code).toBe(1);
  });

  it('rejects empty argv', async () => {
    writeFileSync(join(tempCwd, '.case/active'), 'foo-1');
    const { handler } = await import('../commands/update-memory.js');
    const code = await handler([]);
    expect(code).toBe(1);
  });

  it('supports --help', async () => {
    const { handler } = await import('../commands/update-memory.js');
    const code = await handler(['--help']);
    expect(code).toBe(0);
  });

  it('attaches --error-file and --error-status to most recent --error', async () => {
    writeFileSync(join(tempCwd, '.case/active'), 'foo-1');
    const { handler } = await import('../commands/update-memory.js');
    const code = await handler([
      '--error',
      'TypeError',
      '--error-file',
      'src/x.ts',
      '--error-status',
      'fixed',
      '--error',
      'RangeError',
      '--error-status',
      'workaround',
    ]);
    expect(code).toBe(0);
    const memory = JSON.parse(readFileSync(join(tempCwd, '.case/foo-1/working-memory.json'), 'utf-8'));
    expect(memory.errorsSeen).toEqual([
      { error: 'TypeError', file: 'src/x.ts', resolution: 'fixed' },
      { error: 'RangeError', resolution: 'workaround' },
    ]);
  });
});
