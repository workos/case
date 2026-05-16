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
import * as upload from './upload.js';
import * as snapshot from './snapshot.js';
import * as init from './init.js';

export interface Command {
  handler: (argv: string[]) => Promise<number>;
  description: string;
}

export const commandMap: Record<string, Command> = {
  run: { handler: run.handler, description: run.description },
  watch: { handler: watch.handler, description: watch.description },
  create: { handler: create.handler, description: create.description },
  session: { handler: session.handler, description: session.description },
  status: { handler: status.handler, description: status.description },
  'mark-tested': { handler: markTested.handler, description: markTested.description },
  'mark-manual-tested': {
    handler: markManualTested.handler,
    description: markManualTested.description,
  },
  'mark-reviewed': { handler: markReviewed.handler, description: markReviewed.description },
  upload: { handler: upload.handler, description: upload.description },
  snapshot: { handler: snapshot.handler, description: snapshot.description },
  init: { handler: init.handler, description: init.description },
};

export async function dispatch(argv: string[]): Promise<number> {
  // No verb → default to `run` for back-compat.
  if (argv.length === 0) {
    return commandMap.run.handler([]);
  }

  // Router-level help.
  if (argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
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

export function printHelp(): void {
  const lines: string[] = [];
  lines.push('Usage: ca <command> [options]');
  lines.push('');
  lines.push('Commands:');

  const verbs = Object.keys(commandMap);
  const pad = Math.max(...verbs.map((v) => v.length)) + 2;
  for (const verb of verbs) {
    lines.push(`  ${verb.padEnd(pad)}${commandMap[verb]!.description}`);
  }
  lines.push('');
  lines.push('Run `ca <command> --help` for command-specific options.');
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
