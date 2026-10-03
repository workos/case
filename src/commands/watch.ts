import { parseArgs } from 'node:util';

export const description = 'Live-tail a task run from its Langfuse trace';

export async function handler(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      raw: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      run: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const taskSlug = positionals[0];
  if (!taskSlug) {
    process.stderr.write('Error: case watch <taskSlug> is required\n');
    return 1;
  }

  // Apply --no-color before importing the renderer so `isColorEnabled()`
  // (evaluated lazily at render time) reflects the flag.
  if (values['no-color']) {
    process.env.NO_COLOR = '1';
  }

  const { watchTrace, WatchKeysMissingError } = await import('../watch/watcher.js');
  const { renderWatchEvent } = await import('../watch/renderer.js');
  const format = values.raw ? ('raw' as const) : ('structured' as const);
  const runId = typeof values.run === 'string' ? values.run : undefined;

  try {
    for await (const record of watchTrace({ taskSlug, runId, format })) {
      process.stdout.write(renderWatchEvent(record) + '\n');
    }
  } catch (err) {
    if (err instanceof WatchKeysMissingError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  return 0;
}
