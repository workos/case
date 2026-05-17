import { repoRoot } from './ast-grep.js';

export interface SequenceStep {
  label: string;
  args: string[];
  cwd?: string;
}

export async function runSequence(steps: SequenceStep[]): Promise<void> {
  for (const step of steps) {
    process.stdout.write(`\n=== ${step.label} ===\n`);
    const proc = Bun.spawn(step.args, {
      cwd: step.cwd ?? repoRoot,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) process.exit(exitCode);
  }
}
