import { spawnScript } from './spawn.js';

export const description = 'Mark a repo as reviewed (writes .case-reviewed)';

export function handler(argv: string[]): Promise<number> {
  return spawnScript('mark-reviewed.sh', argv);
}
