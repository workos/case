import type { Notifier } from '../notify.js';
import { defaultAskUser } from '../notify.js';
import type { PipelineMode } from '../types.js';
import { bold, cyan, dim, green, red, yellow } from './color.js';
import { formatDuration, formatHeartbeatWhimsy, formatPhaseEnd, formatPhaseHeader, formatToolLine } from './format.js';

export interface StructuredLogRendererOptions {
  /** Output sink. Default: writes to process.stdout. */
  write?: (text: string) => void;
  mode: PipelineMode;
  /** Heartbeat tick interval in ms. Default: 10_000. */
  heartbeatIntervalMs?: number;
  /** Override for the wall clock (testing). Default: Date.now. */
  now?: () => number;
  /** Override for the interval scheduler (testing). */
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Duration thresholds for color escalation (ms). */
const DURATION_YELLOW_MS = 30_000;
const DURATION_RED_MS = 120_000;

/**
 * Return a duration string colored by its magnitude.
 *   < 30s  → default
 *   < 2min → yellow
 *   ≥ 2min → red
 */
function colorDuration(durationMs: number): string {
  const text = formatDuration(durationMs);
  if (durationMs >= DURATION_RED_MS) return red(text);
  if (durationMs >= DURATION_YELLOW_MS) return yellow(text);
  return text;
}

/**
 * Recolor a formatted phase-end line: green or red icon + threshold-colored
 * duration. Body padding stays default.
 */
function colorPhaseEndLine(phase: string, agent: string, durationMs: number, status: 'completed' | 'failed'): string {
  const raw = formatPhaseEnd(phase, agent, durationMs, status);
  const durText = formatDuration(durationMs);
  const body = raw.endsWith(durText) ? raw.slice(0, raw.length - durText.length) : raw;
  const icon = status === 'completed' ? green(body[0]!) : red(body[0]!);
  return `${icon}${body.slice(1)}${colorDuration(durationMs)}`;
}

/**
 * Build a colored step-indicator line: green ✓ completed, cyan ○ active,
 * dim · pending (with pending phase names dimmed too).
 */
function colorStepIndicator(completed: string[], active: string, pending: string[]): string {
  const total = completed.length + (active ? 1 : 0) + pending.length;
  const position = completed.length + (active ? 1 : 0);
  const parts: string[] = [];
  for (const phase of completed) parts.push(`${green('✓')} ${phase}`);
  if (active) parts.push(`${cyan('○')} ${active}`);
  for (const phase of pending) parts.push(`${dim('·')} ${dim(phase)}`);
  return `[${position}/${total}] ${parts.join(' → ')}`;
}

/**
 * Color a phase header line: bold prefix, dim trailing separator.
 */
function colorPhaseHeader(phase: string, agent: string): string {
  const raw = formatPhaseHeader(phase, agent);
  const sepMatch = raw.match(/─+$/);
  if (!sepMatch) return bold(raw);
  const sepStart = raw.length - sepMatch[0].length;
  return `${bold(raw.slice(0, sepStart))}${dim(raw.slice(sepStart))}`;
}

/**
 * Color a tool activity line: whole line dim, duration threshold-colored.
 */
function colorToolLine(tool: string, args: string, durationMs?: number): string {
  if (durationMs === undefined) return dim(formatToolLine(tool, args));
  const raw = formatToolLine(tool, args, durationMs);
  const durText = formatDuration(durationMs);
  const leftRaw = raw.endsWith(durText) ? raw.slice(0, raw.length - durText.length) : raw;
  return `${dim(leftRaw)}${colorDuration(durationMs)}`;
}

/**
 * StructuredLogRenderer — implements the full Notifier interface using plain text
 * decorated with ANSI color (TTY-detected; suppressed under NO_COLOR; forced
 * under FORCE_COLOR). Renders phase boundaries, tool activity, step indicators,
 * and a whimsical thinking heartbeat.
 *
 * The heartbeat is a wall-clock setInterval that prints rotating "thinking"
 * lines while the agent is silent. Each tool/phase event resets the elapsed
 * counter and the tick counter, so heartbeats fire only during true silence
 * and the whimsy message starts fresh each time.
 */
export function createStructuredLogRenderer(options: StructuredLogRendererOptions): Notifier {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const mode = options.mode;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const setIntervalFn = options.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let heartbeatTimer: unknown = null;
  let lastActivityAt = 0;
  let tickCount = 0;

  function writeLine(line: string) {
    write(`${line}\n`);
  }

  return {
    send(message) {
      writeLine(message);
    },

    phaseStart(phase, agent) {
      lastActivityAt = now();
      tickCount = 0;
      writeLine(colorPhaseHeader(phase, agent));
    },

    phaseEnd(phase, agent, durationMs, status) {
      writeLine(colorPhaseEndLine(phase, agent, durationMs, status));
    },

    toolStart(tool, args) {
      lastActivityAt = now();
      tickCount = 0;
      writeLine(colorToolLine(tool, args));
    },

    toolEnd(tool, durationMs, isError) {
      lastActivityAt = now();
      tickCount = 0;
      const suffix = isError ? red(' (error)') : '';
      writeLine(`${colorToolLine(tool, '', durationMs)}${suffix}`);
    },

    stepIndicator(completed, active, pending) {
      writeLine(colorStepIndicator(completed, active, pending));
    },

    startHeartbeat() {
      // Idempotent: clear any prior timer first.
      if (heartbeatTimer !== null) {
        clearIntervalFn(heartbeatTimer);
        heartbeatTimer = null;
      }
      lastActivityAt = now();
      tickCount = 0;
      heartbeatTimer = setIntervalFn(() => {
        const elapsed = now() - lastActivityAt;
        writeLine(dim(formatHeartbeatWhimsy(elapsed, tickCount)));
        tickCount++;
      }, heartbeatIntervalMs);
    },

    stopHeartbeat() {
      if (heartbeatTimer !== null) {
        clearIntervalFn(heartbeatTimer);
        heartbeatTimer = null;
      }
    },

    async askUser(userPrompt, choices) {
      return defaultAskUser(mode, userPrompt, choices);
    },
  };
}
