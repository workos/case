import { parseArgs } from 'node:util';
import { startServer } from '../server.js';
import { createLogger } from '../util/logger.js';
import { resolvePackageRoot } from '../paths.js';
import type { ServerConfig } from '../types.js';

const log = createLogger();

export const description = 'Serve the dashboard locally';

export async function handler(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      'webhook-secret': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const caseRoot = resolvePackageRoot();
  const port = parseInt((values.port as string) ?? '3847', 10);
  const host = (values.host as string) ?? '127.0.0.1';
  const webhookSecret = (values['webhook-secret'] as string) ?? process.env.CASE_WEBHOOK_SECRET;

  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;

  const serverConfig: ServerConfig = {
    port,
    host,
    webhookSecret,
    scanners: {
      ci: {
        enabled: true,
        intervalMs: ONE_HOUR,
        repos: [],
        autoStart: false,
      },
      staleDocs: {
        enabled: true,
        intervalMs: ONE_DAY,
        repos: [],
        autoStart: false,
      },
      deps: {
        enabled: true,
        intervalMs: 7 * ONE_DAY,
        repos: [],
        autoStart: false,
      },
    },
  };

  try {
    await startServer(caseRoot, serverConfig);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('server crashed', { error: msg });
    process.stderr.write(`Fatal: ${msg}\n`);
    return 1;
  }
}
