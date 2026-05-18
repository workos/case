import type { Notifier } from '../notify.js';
import { defaultAskUser } from '../notify.js';
import type { PipelineMode } from '../types.js';
import {
  formatHeartbeat,
  formatPhaseEnd,
  formatPhaseHeader,
  formatStepIndicator,
  formatToolLine,
} from './format.js';

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

/**
 * StructuredLogRenderer — implements the full Notifier interface using plain text.
 * Renders phase boundaries, tool activity, step indicators, and a thinking heartbeat.
 *
 * The heartbeat is a wall-clock setInterval that prints "thinking (Ns)" lines while
 * the agent is silent. Each toolStart resets the elapsed counter, so the heartbeat
 * only fires during true silence.
 */
export function createStructuredLogRenderer(options: StructuredLogRendererOptions): Notifier {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const mode = options.mode;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const setIntervalFn = options.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let heartbeatTimer: unknown = null;
  let lastActivityAt = 0;

  function writeLine(line: string) {
    write(`${line}\n`);
  }

  return {
    send(message) {
      writeLine(message);
    },

    phaseStart(phase, agent) {
      lastActivityAt = now();
      writeLine(formatPhaseHeader(phase, agent));
    },

    phaseEnd(phase, agent, durationMs, status) {
      writeLine(formatPhaseEnd(phase, agent, durationMs, status));
    },

    toolStart(tool, args) {
      lastActivityAt = now();
      writeLine(formatToolLine(tool, args));
    },

    toolEnd(tool, durationMs, isError) {
      lastActivityAt = now();
      const suffix = isError ? ' (error)' : '';
      writeLine(`${formatToolLine(tool, '', durationMs)}${suffix}`);
    },

    stepIndicator(completed, active, pending) {
      writeLine(formatStepIndicator(completed, active, pending));
    },

    startHeartbeat() {
      // Idempotent: clear any prior timer first.
      if (heartbeatTimer !== null) {
        clearIntervalFn(heartbeatTimer);
        heartbeatTimer = null;
      }
      lastActivityAt = now();
      heartbeatTimer = setIntervalFn(() => {
        const elapsed = now() - lastActivityAt;
        writeLine(formatHeartbeat(elapsed));
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
