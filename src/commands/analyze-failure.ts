import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { FailureAnalysis } from '../types.js';

const FAILURE_PATTERNS: Array<{ keywords: string[]; failureClass: string; suggestedFocus: string }> = [
  {
    keywords: ['test', 'vitest', 'jest', 'assert', 'expect'],
    failureClass: 'test-failure',
    suggestedFocus:
      'Review failing test expectations. Check if the test needs updating or if the implementation has a logic error. Focus on the specific test file and the code path it exercises.',
  },
  {
    keywords: ['type', 'typescript', 'ts2', 'ts7'],
    failureClass: 'type-error',
    suggestedFocus:
      'Fix type errors first — they often cascade. Check import paths, generic constraints, and return types. Run tsc --noEmit to get the full list before making changes.',
  },
  {
    keywords: ['lint', 'eslint', 'prettier'],
    failureClass: 'lint-error',
    suggestedFocus:
      'Run the linter with --fix flag first. Remaining issues are usually import ordering or unused variables. Check the repo CLAUDE.md for lint-specific conventions.',
  },
  {
    keywords: ['build', 'compile', 'module', 'import', 'export', 'resolve'],
    failureClass: 'build-error',
    suggestedFocus:
      'Check import/export paths and ESM extensions. Verify the module is properly exported from package entry points. Build errors often cascade — fix the first one and re-run.',
  },
  {
    keywords: ['timeout', 'hang', 'stuck', 'doom'],
    failureClass: 'timeout-or-loop',
    suggestedFocus:
      'The previous approach hit a loop or timeout. Try a fundamentally different strategy instead of tweaking the same approach. Consider if there is a simpler solution.',
  },
  {
    keywords: ['no structured output', 'agent_result'],
    failureClass: 'agent-protocol-error',
    suggestedFocus:
      'The agent did not produce a structured AGENT_RESULT. This usually means it ran out of context or hit an unrecoverable error. Simplify the task scope for the retry.',
  },
];

function classifyError(errorSummary: string): { failureClass: string; suggestedFocus: string } {
  const lower = errorSummary.toLowerCase();
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.keywords.some((k) => lower.includes(k))) {
      return { failureClass: pattern.failureClass, suggestedFocus: pattern.suggestedFocus };
    }
  }
  return {
    failureClass: 'unknown',
    suggestedFocus:
      'Review the error carefully. Check if a different approach would avoid the issue entirely. Read the working memory for what was already tried.',
  };
}

function parseWorkingMemory(workingFile: string): string[] {
  if (!existsSync(workingFile)) return [];
  const content = readFileSync(workingFile, 'utf-8');
  const items: string[] = [];
  let inSection = false;
  for (const line of content.split('\n')) {
    if (line.includes('## What Was Tried')) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (line.startsWith('## ')) break;
      if (line.startsWith('- ')) items.push(line.slice(2).trim());
    }
  }
  return items;
}

async function getFilesInvolved(cwd?: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(['git', 'diff', '--name-only', 'main'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return [];
    return out.trim().split('\n').filter(Boolean).slice(0, 20);
  } catch {
    return [];
  }
}

export async function analyzeFailure(
  taskFile: string,
  failedAgent: string,
  errorSummary: string,
): Promise<FailureAnalysis> {
  const taskStem = basename(taskFile, '.task.json');
  const taskDir = dirname(taskFile);
  const workingFile = resolve(taskDir, `${taskStem}.working.md`);

  const whatWasTried = parseWorkingMemory(workingFile);
  const filesInvolved = await getFilesInvolved();
  const { failureClass, suggestedFocus: baseFocus } = classifyError(errorSummary);

  let retryViable = true;
  let suggestedFocus = baseFocus;

  if (whatWasTried.length >= 3) {
    retryViable = false;
    suggestedFocus = 'Multiple approaches already tried. Surface to human for guidance rather than retrying.';
  }

  return {
    failureClass,
    failedAgent,
    errorSummary: errorSummary.slice(0, 500),
    filesInvolved,
    whatWasTried,
    suggestedFocus,
    retryViable,
  };
}

export const description = 'Analyze an agent failure for intelligent respawning';

export async function handler(argv: string[]): Promise<number> {
  const taskFile = argv[0];
  const failedAgent = argv[1];
  const errorSummary = argv[2] ?? '';

  if (!taskFile || !failedAgent) {
    process.stderr.write('Usage: ca analyze-failure <task.json> <failed-agent> <error-summary>\n');
    return 1;
  }

  if (!existsSync(taskFile)) {
    process.stderr.write(`Error: task file not found: ${taskFile}\n`);
    return 1;
  }

  const analysis = await analyzeFailure(taskFile, failedAgent, errorSummary);
  process.stdout.write(JSON.stringify(analysis, null, 2) + '\n');
  return 0;
}
