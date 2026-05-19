/**
 * Command registry and router.
 *
 * Each entry in `commandMap` is a `{ handler, description }` pair. The router
 * dispatches the first positional argument to the matching handler, prints
 * `--help`, or suggests the closest verb on a typo via Levenshtein-1 distance.
 *
 * Handlers return `Promise<number>` (exit code). The router never calls
 * `process.exit` — that responsibility lives in `src/index.ts` so handlers
 * stay testable without process termination.
 */

import * as run from './run.js';
import * as watch from './watch.js';
import * as create from './create.js';
import * as session from './session.js';
import * as status from './status.js';
import * as markTested from './mark-tested.js';
import * as markManualTested from './mark-manual-tested.js';
import * as markReviewed from './mark-reviewed.js';
import * as updateMemory from './update-memory.js';
import * as upload from './upload.js';
import * as snapshot from './snapshot.js';
import * as init from './init.js';
import * as analyzeFailure from './analyze-failure.js';
import * as bootstrap from './bootstrap.js';
import * as check from './check.js';
import * as onboard from './onboard.js';

export type CommandGroup = 'human' | 'agent' | 'internal';

export interface Command {
  handler: (argv: string[]) => Promise<number>;
  description: string;
  group: CommandGroup;
}

export const commandMap: Record<string, Command> = {
  run: { handler: run.handler, description: run.description, group: 'human' },
  watch: { handler: watch.handler, description: watch.description, group: 'human' },
  init: { handler: init.handler, description: init.description, group: 'human' },
  check: { handler: check.handler, description: check.description, group: 'human' },
  bootstrap: { handler: bootstrap.handler, description: bootstrap.description, group: 'human' },
  onboard: { handler: onboard.handler, description: onboard.description, group: 'human' },
  session: { handler: session.handler, description: session.description, group: 'agent' },
  status: { handler: status.handler, description: status.description, group: 'agent' },
  'mark-tested': { handler: markTested.handler, description: markTested.description, group: 'agent' },
  'mark-manual-tested': {
    handler: markManualTested.handler,
    description: markManualTested.description,
    group: 'agent',
  },
  'mark-reviewed': { handler: markReviewed.handler, description: markReviewed.description, group: 'agent' },
  'update-memory': { handler: updateMemory.handler, description: updateMemory.description, group: 'agent' },
  upload: { handler: upload.handler, description: upload.description, group: 'agent' },
  snapshot: { handler: snapshot.handler, description: snapshot.description, group: 'agent' },
  create: { handler: create.handler, description: create.description, group: 'internal' },
  'analyze-failure': { handler: analyzeFailure.handler, description: analyzeFailure.description, group: 'internal' },
};

export async function dispatch(argv: string[]): Promise<number> {
  // No verb → default to `run` for back-compat.
  if (argv.length === 0) {
    return commandMap.run.handler([]);
  }

  // Router-level flags.
  if (argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }

  if (argv[0] === '--version' || argv[0] === '-V') {
    const { version } = await import('../version.js');
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const verb = argv[0];

  // Treat top-level flags (starting with `-`) as args to the default `run` handler.
  // Preserves back-compat with `ca --task foo.json`, `ca -t foo.json`, etc.
  if (verb && verb.startsWith('-')) {
    return commandMap.run.handler(argv);
  }

  const cmd = commandMap[verb!];
  if (!cmd) {
    // Not a registered verb — forward to `run` as a bare positional argument
    // (issue number, Linear ID, freeform text). Preserves back-compat with
    // `case 1234`, `ca DX-1234`, `ca "fix login bug"`.
    return commandMap.run.handler(argv);
  }

  return cmd.handler(argv.slice(1));
}

const groupMeta: Record<CommandGroup, { label: string; note?: string }> = {
  human: { label: 'Commands' },
  agent: { label: 'Agent commands', note: 'Used by pipeline agents — not typically run by hand.' },
  internal: { label: 'Internal', note: 'Called programmatically by the orchestrator.' },
};

export function printHelp(): void {
  const lines: string[] = [];
  lines.push('Usage: ca <command> [options]');
  lines.push('       ca [issue]');
  lines.push('       ca --agent [issue]');
  lines.push('');
  lines.push('Core:');
  lines.push('  ca 1234           Create or resume a pipeline run from a GitHub issue');
  lines.push('  ca --agent 1234   Start an interactive steering session before running');

  const allVerbs = Object.keys(commandMap);
  const pad = Math.max(...allVerbs.map((v) => v.length)) + 2;

  for (const group of ['human', 'agent', 'internal'] as CommandGroup[]) {
    const verbs = allVerbs.filter((v) => commandMap[v]!.group === group);
    if (verbs.length === 0) continue;
    const { label, note } = groupMeta[group];
    lines.push('');
    lines.push(`${label}:${note ? `  (${note})` : ''}`);
    for (const verb of verbs) {
      lines.push(`  ${verb.padEnd(pad)}${commandMap[verb]!.description}`);
    }
  }

  lines.push('');
  lines.push('Run `ca <command> --help` for command-specific options.');
  lines.push('Run `ca --version` to print the version.');
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

/**
 * Suggest the closest verb from `candidates` to `input`, or `undefined` if
 * the best match has Levenshtein distance > 2 (too dissimilar to be useful).
 */
export function suggest(input: string, candidates: string[]): string | undefined {
  let best: { verb: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(input, candidate);
    if (best === undefined || distance < best.distance) {
      best = { verb: candidate, distance };
    }
  }
  if (best && best.distance <= 2) {
    return best.verb;
  }
  return undefined;
}

/**
 * Classic two-row dynamic-programming Levenshtein distance.
 * Used only for verb suggestion, so input sizes are tiny.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from<number>({ length: b.length + 1 });
  let curr = Array.from<number>({ length: b.length + 1 });
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}
