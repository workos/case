import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { updateTaskJson } from './mark-tested.js';

export const description = 'Mark a repo as manually tested (writes .case/<slug>/manual-tested)';

function resolveTaskSlug(): string | null {
  if (!existsSync('.case/active')) return null;
  return readFileSync('.case/active', 'utf-8').trim() || null;
}

function countRecentPngs(dir: string, maxAgeMinutes: number): number {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  let count = 0;
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.png')) continue;
      try {
        if (statSync(join(dir, entry)).mtimeMs > cutoff) count++;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* dir unreadable */
  }
  return count;
}

export async function handler(argv: string[]): Promise<number> {
  const slug = resolveTaskSlug();
  if (!slug) {
    process.stderr.write('ERROR: No active task — .case/active is missing or empty. Run the orchestrator first.\n');
    return 1;
  }

  const markerDir = `.case/${slug}`;
  mkdirSync(markerDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const mode = argv.includes('--library') ? 'library' : 'playwright';
  let evidenceDetails = '';

  if (mode === 'library') {
    if (process.stdin.isTTY) {
      process.stderr.write(
        'REFUSED: No test output piped to stdin. Usage: pnpm test 2>&1 | ca mark-manual-tested --library\n',
      );
      return 1;
    }
    const content = await new Response(process.stdin as unknown as ReadableStream).text();
    if (content.length < 10) {
      process.stderr.write('REFUSED: No test output piped to stdin.\n');
      return 1;
    }
    const hash = createHash('sha256').update(content).digest('hex');
    const passCount = (content.match(/pass|passed|✓|ok/gi) ?? []).length;
    if (passCount < 1) {
      process.stderr.write('REFUSED: Test output contains no pass indicators. Tests may have failed.\n');
      return 1;
    }
    evidenceDetails = `library-test-verification: output_hash=${hash.slice(0, 16)} pass_indicators=${passCount}`;
  } else {
    const playwrightCount = countRecentPngs('.playwright-cli', 60);
    if (playwrightCount > 0) {
      evidenceDetails = `playwright-cli screenshots: ${playwrightCount} files in .playwright-cli/ (last hour)`;
    } else {
      const tmpCount = countRecentPngs('/tmp', 60);
      if (tmpCount > 0) evidenceDetails = `screenshots: ${tmpCount} recent .png files in /tmp (last hour)`;
    }
    if (!evidenceDetails) {
      process.stderr.write(
        'REFUSED: No evidence of manual testing found.\n\nExpected one of:\n  - .playwright-cli/ directory with recent screenshots\n  - Recent .png files in /tmp from playwright-cli screenshot\n\nRun playwright-cli to test the app first, then re-run this script.\n',
      );
      return 1;
    }
  }

  writeFileSync(resolve(markerDir, 'manual-tested'), `timestamp: ${timestamp}\nevidence: ${evidenceDetails}\n`);
  process.stderr.write(`.case/${slug}/manual-tested created (${evidenceDetails})\n`);
  updateTaskJson(slug, 'manualTested');
  return 0;
}
