import { spawnScript } from './spawn.js';

export const description = 'Mark a repo as auto-tested (writes .case-tested with SHA-256 of stdin)';

/**
 * TTY guard prevents silent empty-hash markers when an agent invokes
 * `case mark-tested` without piping test output. Without this guard,
 * mark-tested.sh would compute SHA-256 of the empty string and write a
 * false-positive evidence marker.
 */
export async function handler(argv: string[]): Promise<number> {
  if (process.stdin.isTTY) {
    process.stderr.write('mark-tested requires test output on stdin: <test-cmd> | case mark-tested --repo <path>\n');
    return 1;
  }
  return spawnScript('mark-tested.sh', argv);
}
