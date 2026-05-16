import { spawnScript } from './spawn.js';

export const description = 'Snapshot current agent prompt versions to docs/agent-versions/';

export function handler(argv: string[]): Promise<number> {
  return spawnScript('snapshot-agent.sh', argv);
}
