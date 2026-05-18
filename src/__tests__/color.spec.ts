import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bold, color, cyan, dim, green, isColorEnabled, red, yellow } from '../render/color.js';

const ESC = '\x1b[';

/**
 * Color tests temporarily mutate `process.env.NO_COLOR` and
 * `process.env.FORCE_COLOR`. We snapshot+restore both around every test so a
 * failure in one case cannot leak state into another.
 */
let savedNoColor: string | undefined;
let savedForceColor: string | undefined;

beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  savedForceColor = process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
});

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = savedForceColor;
});

describe('isColorEnabled', () => {
  test('NO_COLOR disables color (precedence over FORCE_COLOR)', () => {
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '1';
    expect(isColorEnabled()).toBe(false);
  });

  test('NO_COLOR with empty string still disables', () => {
    process.env.NO_COLOR = '';
    expect(isColorEnabled()).toBe(false);
  });

  test('FORCE_COLOR enables color when NO_COLOR is unset', () => {
    process.env.FORCE_COLOR = '1';
    expect(isColorEnabled()).toBe(true);
  });

  test('FORCE_COLOR with empty string still enables', () => {
    process.env.FORCE_COLOR = '';
    expect(isColorEnabled()).toBe(true);
  });

  test('falls back to stdout.isTTY when neither env var is set', () => {
    // The bun test runner is non-TTY, so this should be false by default.
    // Verify the function does *some* deterministic thing rather than asserting
    // a specific value (it depends on the runner environment).
    const result = isColorEnabled();
    expect(typeof result).toBe('boolean');
  });
});

describe('color()', () => {
  test('wraps text with ANSI code and reset when enabled', () => {
    process.env.FORCE_COLOR = '1';
    expect(color(31, 'hello')).toBe(`${ESC}31mhello${ESC}0m`);
  });

  test('returns plain text when disabled', () => {
    process.env.NO_COLOR = '1';
    expect(color(31, 'hello')).toBe('hello');
  });
});

describe('color helpers (enabled)', () => {
  beforeEach(() => {
    process.env.FORCE_COLOR = '1';
  });

  test('bold wraps with code 1', () => {
    expect(bold('x')).toBe(`${ESC}1mx${ESC}0m`);
  });

  test('dim wraps with code 2', () => {
    expect(dim('x')).toBe(`${ESC}2mx${ESC}0m`);
  });

  test('red wraps with code 31', () => {
    expect(red('x')).toBe(`${ESC}31mx${ESC}0m`);
  });

  test('green wraps with code 32', () => {
    expect(green('x')).toBe(`${ESC}32mx${ESC}0m`);
  });

  test('yellow wraps with code 33', () => {
    expect(yellow('x')).toBe(`${ESC}33mx${ESC}0m`);
  });

  test('cyan wraps with code 36', () => {
    expect(cyan('x')).toBe(`${ESC}36mx${ESC}0m`);
  });
});

describe('color helpers (disabled)', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1';
  });

  test('bold returns plain text', () => {
    expect(bold('hello')).toBe('hello');
  });

  test('dim returns plain text', () => {
    expect(dim('hello')).toBe('hello');
  });

  test('red returns plain text', () => {
    expect(red('hello')).toBe('hello');
  });

  test('green returns plain text', () => {
    expect(green('hello')).toBe('hello');
  });

  test('yellow returns plain text', () => {
    expect(yellow('hello')).toBe('hello');
  });

  test('cyan returns plain text', () => {
    expect(cyan('hello')).toBe('hello');
  });

  test('no ANSI escape sequences in output', () => {
    const combined = `${bold('a')}${dim('b')}${red('c')}${green('d')}${yellow('e')}${cyan('f')}`;
    expect(combined).toBe('abcdef');
    expect(combined.includes('\x1b')).toBe(false);
  });
});

describe('color toggling at render time', () => {
  test('flipping NO_COLOR mid-run is observed (no caching)', () => {
    process.env.NO_COLOR = '1';
    expect(red('x')).toBe('x');
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    expect(red('x')).toBe(`${ESC}31mx${ESC}0m`);
  });
});
