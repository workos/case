import { spawnScript } from './spawn.js';

export const description = 'Read or update the current task status';

export function handler(argv: string[]): Promise<number> {
  return spawnScript('task-status.sh', argv);
}
