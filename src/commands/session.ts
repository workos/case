import { spawnScript } from './spawn.js';

export const description = 'Print session context (git branch, task file, repo info)';

export function handler(argv: string[]): Promise<number> {
  return spawnScript('session-start.sh', argv);
}
