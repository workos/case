import { describe, it, expect } from 'bun:test';
import { sanitizeForTrace } from '../tracing/sanitize.js';

describe('sanitizeForTrace', () => {
  // --- Nullish inputs ---

  it('returns empty string for undefined', () => {
    expect(sanitizeForTrace(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(sanitizeForTrace(null)).toBe('');
  });

  // --- Pass-through ---

  it('passes through short strings unchanged', () => {
    expect(sanitizeForTrace('npm test')).toBe('npm test');
  });

  it('stringifies objects to JSON', () => {
    const result = sanitizeForTrace({ command: 'npm test', cwd: '/repo' });
    expect(result).toBe('{"command":"npm test","cwd":"/repo"}');
  });

  it('stringifies arrays', () => {
    expect(sanitizeForTrace([1, 2, 3])).toBe('[1,2,3]');
  });

  it('stringifies numbers', () => {
    expect(sanitizeForTrace(42)).toBe('42');
  });

  it('stringifies booleans', () => {
    expect(sanitizeForTrace(true)).toBe('true');
  });

  // --- Truncation ---

  it('truncates strings exceeding maxLen', () => {
    const long = 'a'.repeat(600);
    const result = sanitizeForTrace(long, 100);
    expect(result.length).toBe(100);
    expect(result).toEndWith('…[truncated]');
  });

  it('does not truncate strings at exactly maxLen', () => {
    const exact = 'b'.repeat(500);
    const result = sanitizeForTrace(exact);
    expect(result).toBe(exact);
    expect(result).not.toContain('truncated');
  });

  it('respects custom maxLen', () => {
    const input = 'x'.repeat(200);
    const result = sanitizeForTrace(input, 50);
    expect(result.length).toBe(50);
  });

  // --- Secret redaction ---

  it('redacts token values in JSON objects', () => {
    const input = { token: 'sk-abc123secret', command: 'npm test' };
    const result = sanitizeForTrace(input);
    expect(result).toContain('"token":"***"');
    expect(result).toContain('"command":"npm test"');
    expect(result).not.toContain('sk-abc123secret');
  });

  it('redacts password values', () => {
    const input = { password: 'hunter2', user: 'admin' };
    const result = sanitizeForTrace(input);
    expect(result).toContain('"password":"***"');
    expect(result).not.toContain('hunter2');
  });

  it('redacts api_key values', () => {
    const input = { api_key: 'key_live_abcdef' };
    const result = sanitizeForTrace(input);
    expect(result).toContain('"api_key":"***"');
    expect(result).not.toContain('key_live_abcdef');
  });

  it('redacts authorization headers', () => {
    const input = { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' };
    const result = sanitizeForTrace(input);
    expect(result).toContain('"authorization":"***"');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts access_token values', () => {
    const input = { access_token: 'gho_xxxxxxxxxxxx' };
    const result = sanitizeForTrace(input);
    expect(result).not.toContain('gho_xxxxxxxxxxxx');
  });

  it('redacts secret in string form (key=value)', () => {
    const input = 'secret=supersecretvalue123 --verbose';
    const result = sanitizeForTrace(input);
    expect(result).not.toContain('supersecretvalue123');
    expect(result).toContain('secret=***');
  });

  it('is case-insensitive for key names', () => {
    const input = { TOKEN: 'abc123', Password: 'xyz789' };
    const result = sanitizeForTrace(input);
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('xyz789');
  });

  it('preserves non-secret values', () => {
    const input = { command: 'git diff', cwd: '/home/user/repo', exitCode: 0 };
    const result = sanitizeForTrace(input);
    expect(result).toContain('git diff');
    expect(result).toContain('/home/user/repo');
    expect(result).toContain('"exitCode":0');
  });

  // --- Combined: redaction + truncation ---

  it('redacts before truncating', () => {
    const input = { token: 'sk-verylongsecretkey', data: 'x'.repeat(600) };
    const result = sanitizeForTrace(input, 100);
    expect(result).not.toContain('sk-verylongsecretkey');
    expect(result.length).toBe(100);
    expect(result).toEndWith('…[truncated]');
  });
});
