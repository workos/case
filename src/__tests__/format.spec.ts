import { describe, test, expect } from 'bun:test';
import {
  formatDuration,
  formatHeartbeat,
  formatPhaseEnd,
  formatPhaseHeader,
  formatStepIndicator,
  formatToolLine,
} from '../render/format.js';

describe('formatDuration', () => {
  test('returns <1s for 0ms', () => {
    expect(formatDuration(0)).toBe('<1s');
  });

  test('returns <1s for 999ms', () => {
    expect(formatDuration(999)).toBe('<1s');
  });

  test('returns Ns for 1000ms', () => {
    expect(formatDuration(1000)).toBe('1s');
  });

  test('returns Ns for 59999ms', () => {
    expect(formatDuration(59_999)).toBe('59s');
  });

  test('returns Nm Ss boundary at 60000ms', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
  });

  test('formats minutes and seconds', () => {
    expect(formatDuration(102_000)).toBe('1m 42s');
  });
});

describe('formatPhaseHeader', () => {
  test('starts with arrow icon and includes phase+agent', () => {
    const out = formatPhaseHeader('implement', 'implementer');
    expect(out.startsWith('▶ implement (implementer)')).toBe(true);
  });

  test('pads to fixed width with separator', () => {
    const out = formatPhaseHeader('implement', 'implementer');
    expect(out.length).toBe(60);
    expect(out.includes('─')).toBe(true);
  });
});

describe('formatPhaseEnd', () => {
  test('uses ✓ for completed', () => {
    const out = formatPhaseEnd('implement', 'implementer', 102_000, 'completed');
    expect(out.startsWith('✓ implement completed')).toBe(true);
    expect(out.endsWith('1m 42s')).toBe(true);
  });

  test('uses ✗ for failed', () => {
    const out = formatPhaseEnd('implement', 'implementer', 102_000, 'failed');
    expect(out.startsWith('✗ implement failed')).toBe(true);
    expect(out.endsWith('1m 42s')).toBe(true);
  });
});

describe('formatToolLine', () => {
  test('renders tool name + args without duration', () => {
    expect(formatToolLine('Read', 'src/auth/handler.ts')).toBe('    ↳ Read src/auth/handler.ts');
  });

  test('renders tool name + args + duration right-aligned', () => {
    const out = formatToolLine('Read', 'src/auth/handler.ts', 2000);
    expect(out.startsWith('    ↳ Read src/auth/handler.ts')).toBe(true);
    expect(out.endsWith('2s')).toBe(true);
  });

  test('handles empty args', () => {
    expect(formatToolLine('Bash', '')).toBe('    ↳ Bash');
  });

  test('handles long args (no truncation in phase 1)', () => {
    const longArg = 'a/very/long/path/that/exceeds/the/normal/width/of/the/terminal.ts';
    const out = formatToolLine('Read', longArg);
    expect(out.includes(longArg)).toBe(true);
  });
});

describe('formatStepIndicator', () => {
  test('renders with no completed phases', () => {
    const out = formatStepIndicator([], 'implement', ['verify', 'review', 'close', 'retro']);
    expect(out).toBe('[1/5] ○ implement → · verify → · review → · close → · retro');
  });

  test('renders with active in middle', () => {
    const out = formatStepIndicator(['implement', 'verify'], 'review', ['close', 'retro']);
    expect(out).toBe('[3/5] ✓ implement → ✓ verify → ○ review → · close → · retro');
  });

  test('renders with all completed (no active)', () => {
    const out = formatStepIndicator(['implement', 'verify', 'review', 'close', 'retro'], '', []);
    expect(out.startsWith('[5/5]')).toBe(true);
    expect(out.includes('✓ retro')).toBe(true);
  });
});

describe('formatHeartbeat', () => {
  test('renders thinking line with elapsed duration', () => {
    expect(formatHeartbeat(34_000)).toBe('    ··· thinking (34s)');
  });

  test('handles sub-second elapsed', () => {
    expect(formatHeartbeat(500)).toBe('    ··· thinking (<1s)');
  });
});
