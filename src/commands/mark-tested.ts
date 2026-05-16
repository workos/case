import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDataDir, resolvePackageRoot } from '../paths.js';

export const description = 'Mark a repo as auto-tested (writes .case/<slug>/tested with SHA-256 of test output)';

function resolveTaskSlug(): string | null {
  if (!existsSync('.case/active')) return null;
  return readFileSync('.case/active', 'utf-8').trim() || null;
}

function parseVitestJson(raw: string): {
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  suites: number;
  files: unknown[];
} {
  const data = JSON.parse(raw);
  const testResults = data.testResults ?? [];
  return {
    passed: data.numPassedTests ?? 0,
    failed: data.numFailedTests ?? 0,
    total: data.numTotalTests ?? 0,
    durationMs: testResults.reduce(
      (s: number, r: { perfStats?: { end?: number; start?: number } }) =>
        s + ((r.perfStats?.end ?? 0) - (r.perfStats?.start ?? 0)),
      0,
    ),
    suites: testResults.length,
    files: testResults.map(
      (r: {
        name?: string;
        status?: string;
        assertionResults?: unknown[];
        perfStats?: { end?: number; start?: number };
      }) => ({
        name: r.name?.split('/').pop() ?? 'unknown',
        status: r.status ?? 'unknown',
        tests: (r.assertionResults ?? []).length,
        duration_ms: (r.perfStats?.end ?? 0) - (r.perfStats?.start ?? 0),
      }),
    ),
  };
}

export async function handler(argv: string[]): Promise<number> {
  if (process.stdin.isTTY && !argv.find((a) => !a.startsWith('--') && existsSync(a))) {
    process.stderr.write(
      'mark-tested requires test output on stdin or as a file argument: <test-cmd> | ca mark-tested\n',
    );
    return 1;
  }

  const slug = resolveTaskSlug();
  if (!slug) {
    process.stderr.write('ERROR: No active task — .case/active is missing or empty. Run the orchestrator first.\n');
    return 1;
  }

  const markerDir = `.case/${slug}`;
  mkdirSync(markerDir, { recursive: true });

  let content: string;
  const fileArg = argv.find((a) => !a.startsWith('--') && existsSync(a));
  if (fileArg) {
    content = readFileSync(fileArg, 'utf-8');
  } else {
    content = await new Response(process.stdin as unknown as ReadableStream).text();
  }

  const hash = createHash('sha256').update(content).digest('hex');
  const timestamp = new Date().toISOString();
  const firstChar = content.trimStart()[0];
  let markerContent: string;

  if (firstChar === '{') {
    const parsed = parseVitestJson(content);
    markerContent = `timestamp: ${timestamp}\noutput_hash: ${hash}\npass_indicators: ${parsed.passed}\nfail_indicators: ${parsed.failed}\npassed: ${parsed.passed}\nfailed: ${parsed.failed}\ntotal: ${parsed.total}\nduration_ms: ${parsed.durationMs}\nsuites: ${parsed.suites}\nfiles: ${JSON.stringify(parsed.files)}\n`;
  } else {
    const passCount = (content.match(/pass|passed|✓|ok/gi) ?? []).length;
    const failCount = (content.match(/fail|failed|✗|error/gi) ?? []).length;
    markerContent = `timestamp: ${timestamp}\noutput_hash: ${hash}\npass_indicators: ${passCount}\nfail_indicators: ${failCount}\n`;
  }

  writeFileSync(resolve(markerDir, 'tested'), markerContent);
  process.stderr.write(`.case/${slug}/tested created (hash: ${hash.slice(0, 12)}...)\n`);

  updateTaskJson(slug, 'tested');
  return 0;
}

export function updateTaskJson(slug: string, field: 'tested' | 'manualTested'): void {
  let dataRoot: string;
  try {
    dataRoot = resolveDataDir();
  } catch {
    dataRoot = resolvePackageRoot();
  }

  let taskJson = resolve(dataRoot, 'tasks', 'active', `${slug}.task.json`);
  if (!existsSync(taskJson)) taskJson = resolve(resolvePackageRoot(), 'tasks', 'active', `${slug}.task.json`);
  if (!existsSync(taskJson)) {
    process.stderr.write(`WARNING: task JSON not found for ${slug}\n`);
    return;
  }

  try {
    const data = JSON.parse(readFileSync(taskJson, 'utf-8'));
    data[field] = true;
    writeFileSync(taskJson, JSON.stringify(data, null, 2) + '\n');
  } catch {
    /* best-effort */
  }
}
