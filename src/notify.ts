import type { PipelineMode } from './types.js';

export interface Notifier {
  send(message: string): void;
  askUser(prompt: string, options: string[]): Promise<string>;
}

/**
 * Attended mode: prompts human via Bun's prompt() global.
 * Unattended mode: auto-selects the last option (by convention, the safe default / "Abort").
 */
export function createNotifier(mode: PipelineMode): Notifier {
  if (mode === 'unattended') {
    return {
      send(message) {
        process.stdout.write(`[unattended] ${message}\n`);
      },
      async askUser(_prompt, options) {
        const choice = options[options.length - 1];
        process.stdout.write(`[unattended] Auto-selecting: ${choice}\n`);
        return choice;
      },
    };
  }

  return {
    send(message) {
      process.stdout.write(`${message}\n`);
    },
    async askUser(userPrompt, options) {
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
  };
}
