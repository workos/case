/**
 * `ca update-memory` — agent-facing CLI to write structured working memory.
 *
 * Agents call this between meaningful steps to record what they tried, what
 * failed, which files changed, and what's blocking them. The orchestrator
 * reads `.case/<task-slug>/working-memory.json` between phases to inject
 * prior context into the next agent's prompt.
 *
 * Flags:
 *   --state <text>            Replace `currentState`
 *   --approach <text>         Replace `approach`
 *   --file <path>             Append to `filesChanged` (repeatable)
 *   --error <text>            Append a new entry to `errorsSeen` (repeatable, paired with --error-status and optional --error-file)
 *   --error-status <enum>     `fixed | workaround | unresolved` — required when paired with --error
 *   --error-file <path>       Optional file for the most recent --error
 *   --tried <text>            Append to `approachesTried` (repeatable, paired with --tried-outcome and optional --tried-reason)
 *   --tried-outcome <enum>    `success | partial | failed` — required when paired with --tried
 *   --tried-reason <text>     Optional reason for the most recent --tried
 *   --blocker <text>          Append to `blockers` (repeatable)
 *
 * Reads existing memory (or starts empty), merges, validates, writes back.
 * Always paired with an active task — resolves the slug from `.case/active`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  emptyWorkingMemory,
  mergeWorkingMemory,
  readWorkingMemory,
  writeWorkingMemory,
} from '../memory/working-memory.js';
import {
  validateWorkingMemoryUpdate,
  WorkingMemoryValidationError,
  type ApproachOutcome,
  type ErrorResolution,
} from '../memory/schema.js';
import type { WorkingMemoryApproach, WorkingMemoryError, WorkingMemoryUpdate } from '../types.js';

export const description = 'Update structured working memory at .case/<slug>/working-memory.json';

function resolveTaskSlug(): string | null {
  if (!existsSync('.case/active')) return null;
  return readFileSync('.case/active', 'utf-8').trim() || null;
}

interface ParsedFlags {
  update: WorkingMemoryUpdate;
  /** Recorded for `--help` / debugging — never affects the merge. */
  changed: boolean;
}

export async function handler(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage());
    return 0;
  }

  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`ERROR: ${(err as Error).message}\n`);
    process.stderr.write(usage());
    return 1;
  }

  if (!parsed.changed) {
    process.stderr.write('ERROR: no fields supplied — pass at least one of --state, --approach, --file, etc.\n');
    process.stderr.write(usage());
    return 1;
  }

  try {
    validateWorkingMemoryUpdate(parsed.update);
  } catch (err) {
    if (err instanceof WorkingMemoryValidationError) {
      process.stderr.write(`ERROR: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const slug = resolveTaskSlug();
  if (!slug) {
    process.stderr.write('ERROR: No active task — .case/active is missing or empty. Run the orchestrator first.\n');
    return 1;
  }

  const taskDir = resolve('.case', slug);
  const existing = readWorkingMemory(taskDir) ?? emptyWorkingMemory();
  const merged = mergeWorkingMemory(existing, parsed.update);

  writeWorkingMemory(taskDir, merged);
  process.stderr.write(`.case/${slug}/working-memory.json updated\n`);
  return 0;
}

function parseFlags(argv: string[]): ParsedFlags {
  const update: WorkingMemoryUpdate = {};
  const filesChanged: string[] = [];
  const blockers: string[] = [];
  const errors: WorkingMemoryError[] = [];
  const tried: WorkingMemoryApproach[] = [];

  // Errors are built incrementally: --error opens a record, --error-status and
  // --error-file decorate the most-recently-opened one. Same for --tried.
  let pendingErrorIdx = -1;
  let pendingTriedIdx = -1;
  let changed = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} requires a value`);
      return v;
    };

    switch (flag) {
      case '--state':
        update.currentState = next();
        changed = true;
        break;
      case '--approach':
        update.approach = next();
        changed = true;
        break;
      case '--file':
        filesChanged.push(next());
        changed = true;
        break;
      case '--blocker':
        blockers.push(next());
        changed = true;
        break;
      case '--error': {
        errors.push({ error: next(), resolution: 'unresolved' });
        pendingErrorIdx = errors.length - 1;
        changed = true;
        break;
      }
      case '--error-status': {
        if (pendingErrorIdx === -1) throw new Error('--error-status must follow --error');
        const value = next();
        if (!isErrorResolution(value)) {
          throw new Error(`--error-status: expected fixed|workaround|unresolved, got "${value}"`);
        }
        errors[pendingErrorIdx]!.resolution = value;
        break;
      }
      case '--error-file': {
        if (pendingErrorIdx === -1) throw new Error('--error-file must follow --error');
        errors[pendingErrorIdx]!.file = next();
        break;
      }
      case '--tried': {
        tried.push({ approach: next(), outcome: 'failed' });
        pendingTriedIdx = tried.length - 1;
        changed = true;
        break;
      }
      case '--tried-outcome': {
        if (pendingTriedIdx === -1) throw new Error('--tried-outcome must follow --tried');
        const value = next();
        if (!isApproachOutcome(value)) {
          throw new Error(`--tried-outcome: expected success|partial|failed, got "${value}"`);
        }
        tried[pendingTriedIdx]!.outcome = value;
        break;
      }
      case '--tried-reason': {
        if (pendingTriedIdx === -1) throw new Error('--tried-reason must follow --tried');
        tried[pendingTriedIdx]!.reason = next();
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  if (filesChanged.length > 0) update.filesChanged = filesChanged;
  if (blockers.length > 0) update.blockers = blockers;
  if (errors.length > 0) update.errorsSeen = errors;
  if (tried.length > 0) update.approachesTried = tried;

  return { update, changed };
}

function isErrorResolution(value: string): value is ErrorResolution {
  return value === 'fixed' || value === 'workaround' || value === 'unresolved';
}

function isApproachOutcome(value: string): value is ApproachOutcome {
  return value === 'success' || value === 'partial' || value === 'failed';
}

function usage(): string {
  return [
    'Usage: ca update-memory [flags]',
    '',
    'Flags:',
    '  --state <text>            Set currentState',
    '  --approach <text>         Set approach',
    '  --file <path>             Append file (repeatable)',
    '  --error <text>            Append error; pair with --error-status and optional --error-file',
    '  --error-status <enum>     fixed | workaround | unresolved',
    '  --error-file <path>       File for the previous --error',
    '  --tried <text>            Append attempted approach; pair with --tried-outcome',
    '  --tried-outcome <enum>    success | partial | failed',
    '  --tried-reason <text>     Reason for the previous --tried',
    '  --blocker <text>          Append blocker (repeatable)',
    '',
    'Writes to .case/<slug>/working-memory.json. Requires .case/active.',
    '',
  ].join('\n');
}
