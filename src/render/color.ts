/**
 * Minimal ANSI color utilities for the structured log renderer.
 * No external dependencies. TTY detection + NO_COLOR / FORCE_COLOR support.
 *
 * `isColorEnabled()` is checked at render time (not cached) so env vars set
 * inside tests take effect immediately.
 */

const ESC = '\x1b[';

/**
 * Returns true when color output should be applied.
 *
 * Precedence:
 *   1. `NO_COLOR` (any value, even empty) → disable.
 *   2. `FORCE_COLOR` (any value, even empty) → enable.
 *   3. Otherwise → only when stdout is a TTY.
 */
export function isColorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return process.stdout.isTTY === true;
}

/**
 * Wrap text with an ANSI SGR code and a reset.
 * Returns plain text when color is disabled.
 */
export function color(code: number, text: string): string {
  return isColorEnabled() ? `${ESC}${code}m${text}${ESC}0m` : text;
}

export const bold = (t: string) => color(1, t);
export const dim = (t: string) => color(2, t);
export const red = (t: string) => color(31, t);
export const green = (t: string) => color(32, t);
export const yellow = (t: string) => color(33, t);
export const cyan = (t: string) => color(36, t);
