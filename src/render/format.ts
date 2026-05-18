/**
 * Pure formatting functions for the structured log renderer.
 * No state, no I/O — just (input → string) so they're trivial to unit test.
 * Phase 1: no ANSI color. Plain text only.
 */

/** Fixed terminal width for phase header separator lines. */
const HEADER_WIDTH = 60;
/** Fixed terminal width target for right-aligned durations in single-line outputs. */
const LINE_WIDTH = 60;

/**
 * Format a duration as a compact human-readable string.
 *   <1000ms        → "<1s"
 *   <60_000ms      → "Ns"
 *   ≥60_000ms      → "Nm Ss"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/**
 * Format the start-of-phase header.
 * Example: "▶ implement (implementer) ───────────────────────"
 */
export function formatPhaseHeader(phase: string, agent: string): string {
  const prefix = `▶ ${phase} (${agent}) `;
  const remaining = Math.max(3, HEADER_WIDTH - prefix.length);
  return prefix + '─'.repeat(remaining);
}

/**
 * Format the end-of-phase line.
 * Example: "✓ implement completed                    1m 42s"
 *          "✗ implement failed                       1m 42s"
 */
export function formatPhaseEnd(
  phase: string,
  _agent: string,
  durationMs: number,
  status: 'completed' | 'failed',
): string {
  const icon = status === 'completed' ? '✓' : '✗';
  const label = status === 'completed' ? 'completed' : 'failed';
  const left = `${icon} ${phase} ${label}`;
  const dur = formatDuration(durationMs);
  return padRight(left, dur);
}

/**
 * Format an indented tool activity line.
 * Example (start):  "    ↳ Read src/auth/handler.ts"
 * Example (end):    "    ↳ Read src/auth/handler.ts               2s"
 */
export function formatToolLine(tool: string, args: string, durationMs?: number): string {
  const argsPart = args ? ` ${args}` : '';
  const left = `    ↳ ${tool}${argsPart}`;
  if (durationMs === undefined) return left;
  return padRight(left, formatDuration(durationMs));
}

/**
 * Format a setup-phase step line. Same shape as a tool line but without
 * trailing duration — setup steps complete fast enough that per-step timing
 * adds noise.
 * Example: "    ↳ Detect repo: authkit-nextjs"
 */
export function formatSetupStep(label: string, detail?: string): string {
  const suffix = detail ? `: ${detail}` : '';
  return `    ↳ ${label}${suffix}`;
}

/**
 * Format the step-indicator line summarizing pipeline position.
 * Example: "[2/5] ✓ implement → ○ verify → · review → · close → · retro"
 *   ✓ = completed   ○ = active   · = pending
 */
export function formatStepIndicator(completed: string[], active: string, pending: string[]): string {
  const total = completed.length + (active ? 1 : 0) + pending.length;
  const position = completed.length + (active ? 1 : 0);
  const parts: string[] = [];
  for (const phase of completed) parts.push(`✓ ${phase}`);
  if (active) parts.push(`○ ${active}`);
  for (const phase of pending) parts.push(`· ${phase}`);
  return `[${position}/${total}] ${parts.join(' → ')}`;
}

/**
 * Format a single thinking-heartbeat line.
 * Example: "    ··· thinking (34s)"
 */
export function formatHeartbeat(elapsedMs: number): string {
  return `    ··· thinking (${formatDuration(elapsedMs)})`;
}

/**
 * Rotating pool of whimsical thinking messages. Cycled by `tickCount`
 * (deterministic, not random) so users see variety without repetition.
 */
const THINKING_MESSAGES = [
  'thinking...',
  'pondering...',
  'mulling it over...',
  'reading the tea leaves...',
  'consulting the oracle...',
  'staring into the void...',
  'connecting the dots...',
  'chewing on it...',
  'letting it marinate...',
  'downloading more RAM...',
  'asking the rubber duck...',
  'untangling spaghetti...',
  'counting semicolons...',
  'debugging the universe...',
  'reticulating splines...',
] as const;

/**
 * Format a whimsical heartbeat line. The message rotates by `tickCount`
 * modulo the pool size, so tick 0 → "thinking...", tick 14 → "reticulating
 * splines...", tick 15 wraps back to "thinking...".
 */
export function formatHeartbeatWhimsy(elapsedMs: number, tickCount: number): string {
  const idx = ((tickCount % THINKING_MESSAGES.length) + THINKING_MESSAGES.length) % THINKING_MESSAGES.length;
  const msg = THINKING_MESSAGES[idx];
  return `    ··· ${msg} (${formatDuration(elapsedMs)})`;
}

/**
 * Pad a left string with spaces so the right string sits at column LINE_WIDTH.
 * If the combination doesn't fit, falls back to a single space separator.
 */
function padRight(left: string, right: string): string {
  const gap = LINE_WIDTH - left.length - right.length;
  if (gap < 1) return `${left} ${right}`;
  return `${left}${' '.repeat(gap)}${right}`;
}
