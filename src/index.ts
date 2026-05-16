#!/usr/bin/env bun
import './binary-env.js';
import { createLogger } from './util/logger.js';

const log = createLogger();

async function main() {
  const { dispatch } = await import('./commands/index.js');
  const code = await dispatch(process.argv.slice(2));
  process.exit(code);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error('cli crashed', { error: msg });
  process.stderr.write(`Fatal: ${msg}\n`);
  process.exit(1);
});
