import fs from 'node:fs';
import { spawnScript } from './spawn.js';

export const description = 'Upload a screenshot or video to case-assets, print markdown reference';

/**
 * Pre-flights gh CLI availability and file existence before delegating to
 * upload-screenshot.sh. Without these checks the underlying script surfaces
 * opaque shell errors that are hard for agents to recover from.
 */
export async function handler(argv: string[]): Promise<number> {
  // gh CLI pre-flight
  const ghCheck = Bun.spawn(['gh', '--version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const ghCode = await ghCheck.exited;
  if (ghCode !== 0) {
    process.stderr.write('gh CLI not found. Install: https://cli.github.com/\n');
    return 1;
  }

  // File-existence pre-flight on the first positional argument.
  const filePath = argv.find((a) => !a.startsWith('--'));
  if (!filePath || !fs.existsSync(filePath)) {
    process.stderr.write(`upload: file not found: ${filePath ?? '<none>'}\n`);
    return 1;
  }

  return spawnScript('upload-screenshot.sh', argv);
}
