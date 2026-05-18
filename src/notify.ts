import type { PipelineMode, PipelinePhase } from './types.js';

export interface Notifier {
  send(message: string): void;
  phaseStart(phase: PipelinePhase, agent: string): void;
  phaseEnd(phase: PipelinePhase, agent: string, durationMs: number, status: 'completed' | 'failed'): void;
  askUser(prompt: string, options: string[]): Promise<string>;
  /** Indicate a tool invocation has started (rendered as indented tool line). */
  toolStart(tool: string, args: string): void;
  /** Indicate a tool invocation has ended (rendered with duration / error marker). */
  toolEnd(tool: string, durationMs: number, isError: boolean): void;
  /** Render pipeline position (e.g., "[2/5] ✓ implement → ○ verify → ..."). */
  stepIndicator(completedPhases: string[], activePhase: string, pendingPhases: string[]): void;
  /** Start the wall-clock thinking heartbeat timer. */
  startHeartbeat(): void;
  /** Stop the wall-clock thinking heartbeat timer. */
  stopHeartbeat(): void;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/**
 * Attended mode: prompts human via Bun's prompt() global.
 * Unattended mode: auto-selects the last option (by convention, the safe default / "Abort").
 */
export function createNotifier(mode: PipelineMode): Notifier {
  const prefix = mode === 'unattended' ? '[unattended] ' : '';

  function write(message: string) {
    process.stdout.write(`${prefix}${message}\n`);
  }

  return {
    send(message) {
      write(message);
    },

    phaseStart(phase, agent) {
      write(`[${phase}] starting ${agent}...`);
    },

    phaseEnd(phase, agent, durationMs, status) {
      const icon = status === 'completed' ? 'done' : 'FAILED';
      write(`[${phase}] ${agent} ${icon} (${formatDuration(durationMs)})`);
    },

    async askUser(userPrompt, options) {
      if (mode === 'unattended') {
        const choice = options[options.length - 1];
        write(`Auto-selecting: ${choice}`);
        return choice;
      }

      process.stdout.write(`\n${userPrompt}\n`);
      options.forEach((opt, i) => {
        process.stdout.write(`  ${i + 1}. ${opt}\n`);
      });

      const answer = prompt('Choose (number): ') ?? '';
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        return options[idx];
      }
      return options[options.length - 1];
    },

    // New methods — no-op on the legacy notifier (back-compat).
    toolStart() {},
    toolEnd() {},
    stepIndicator() {},
    startHeartbeat() {},
    stopHeartbeat() {},
  };
}

/**
 * Shared askUser implementation used by both the legacy notifier and the
 * structured-log renderer. Kept here so behavior stays consistent.
 */
export async function defaultAskUser(mode: PipelineMode, userPrompt: string, options: string[]): Promise<string> {
  if (mode === 'unattended') {
    const choice = options[options.length - 1];
    process.stdout.write(`[unattended] Auto-selecting: ${choice}\n`);
    return choice;
  }

  process.stdout.write(`\n${userPrompt}\n`);
  options.forEach((opt, i) => {
    process.stdout.write(`  ${i + 1}. ${opt}\n`);
  });

  const answer = prompt('Choose (number): ') ?? '';
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) {
    return options[idx];
  }
  return options[options.length - 1];
}
