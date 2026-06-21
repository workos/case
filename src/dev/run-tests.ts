import { Glob } from 'bun';
import { repoRoot } from './ast-grep.js';
import { runSequence } from './run-sequence.js';

/**
 * Unit specs are run **one file per process**. Several specs install
 * process-global module mocks at top level via Bun's `mock.module()` (e.g.
 * `pipeline.spec` mocks `state/task-store`, `pipeline-tool.spec` mocks
 * `pipeline.js`). Bun applies those mocks at file-load for the whole process
 * and never tears them down, so loading every spec into a single `bun test`
 * run cross-contaminates unrelated files. Isolating each file sidesteps the
 * leakage without forcing every spec to hand-roll mock teardown.
 */
const CONCURRENCY = 8;

async function runIsolatedSpecs(files: string[]): Promise<void> {
  let next = 0;
  const failures: string[] = [];

  async function worker(): Promise<void> {
    while (next < files.length) {
      const file = files[next++];
      const proc = Bun.spawn(['bun', 'test', file], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode === 0) {
        process.stdout.write(`✓ ${file}\n`);
      } else {
        failures.push(file);
        process.stdout.write(`\n✗ ${file}\n${stderr || stdout}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} test file(s) failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exit(1);
  }
}

const glob = new Glob('src/__tests__/**/*.spec.ts');
const specFiles = (await Array.fromAsync(glob.scan({ cwd: repoRoot }))).sort();

process.stdout.write(`\n=== unit tests (${specFiles.length} files, isolated) ===\n`);
await runIsolatedSpecs(specFiles);

await runSequence([{ label: 'standalone tests', args: ['bun', 'test', '--cwd', 'test/standalone'] }]);
