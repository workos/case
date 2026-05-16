import { spawnScript } from './spawn.js';

export const description = 'Mark a repo as manually tested (writes .case-manual-tested)';

export function handler(argv: string[]): Promise<number> {
  return spawnScript('mark-manual-tested.sh', argv);
}
