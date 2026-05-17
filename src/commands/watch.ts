import { parseArgs } from 'node:util';
import { resolvePackageRoot } from '../paths.js';
import { detectRepo } from '../entry/repo-detector.js';

export const description = 'Live-tail a task event log';

export async function handler(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      raw: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });

  const taskSlug = positionals[0];
  if (!taskSlug) {
    process.stderr.write('Error: case watch <taskSlug> is required\n');
    return 1;
  }

  const caseRoot = resolvePackageRoot();
  let stateRoot = process.cwd();
  try {
    stateRoot = (await detectRepo(caseRoot)).path;
  } catch {
    // Allow explicit use from a repo-like directory or tests that pass a temp root.
  }
  const { watchEventLog } = await import('../watch/watcher.js');
  const { renderWatchEvent } = await import('../watch/renderer.js');
  const format = values.raw ? ('raw' as const) : ('structured' as const);

  for await (const event of watchEventLog({ taskSlug, caseRoot: stateRoot, format })) {
    process.stdout.write(renderWatchEvent(event) + '\n');
  }

  return 0;
}
