import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { countLines, listRules, printRuleScan, repoRoot, scanRule, walk } from './ast-grep.js';

const fixturesDir = resolve(repoRoot, 'tests/ast-rules/fixtures');

process.stdout.write('=== Testing target rule violation detection ===\n');
let targetCount = 0;
for (const rule of listRules('target')) {
  const matches = await scanRule(rule, resolve(fixturesDir, 'violations'));
  if (matches.length === 0) {
    process.stdout.write(`FAIL: Rule ${basename(rule, '.yml')} produced no violations\n`);
    process.exit(1);
  }
  process.stdout.write(`  ${basename(rule, '.yml')}: ${matches.length} violation(s)\n`);
  targetCount += matches.length;
}
process.stdout.write(`PASS: Detected ${targetCount} target rule violations\n`);

process.stdout.write('=== Testing self-enforcement rule violation detection ===\n');
let selfCount = 0;
for (const rule of listRules('self')) {
  const matches = await scanRule(rule, resolve(fixturesDir, 'violations'));
  if (matches.length === 0) {
    process.stdout.write(`FAIL: Rule ${basename(rule, '.yml')} produced no violations\n`);
    process.exit(1);
  }
  process.stdout.write(`  ${basename(rule, '.yml')}: ${matches.length} violation(s)\n`);
  selfCount += matches.length;
}
process.stdout.write(`PASS: Detected ${selfCount} self-enforcement violations\n`);

process.stdout.write('=== Testing clean fixtures ===\n');
let cleanCount = 0;
const allRules = [...listRules('target'), ...listRules('self')];
for (const rule of allRules) {
  const matches = await scanRule(rule, resolve(fixturesDir, 'clean'));
  cleanCount += matches.length;
}
if (cleanCount !== 0) {
  process.stdout.write(`FAIL: Found ${cleanCount} false positives in clean fixtures\n`);
  for (const rule of allRules) await printRuleScan(rule, resolve(fixturesDir, 'clean'));
  process.exit(1);
}
process.stdout.write('PASS: No false positives\n');

process.stdout.write('=== Supplementary checks ===\n');
process.stdout.write('--- max-file-length (advisory) ---\n');
let longFiles = 0;
for (const file of walk(repoRoot)) {
  if (!file.endsWith('.ts')) continue;
  if (/\.(spec|test)\.ts$/.test(file)) continue;
  const lines = countLines(file);
  if (lines > 300) {
    process.stdout.write(`warning: ${file} exceeds 300 lines (${lines} lines)\n`);
    longFiles++;
  }
}
process.stdout.write(
  longFiles > 0 ? `INFO: ${longFiles} file(s) exceed 300 lines\n` : 'PASS: No files exceed 300 lines\n',
);

process.stdout.write('--- strict-mode (tsconfig check) ---\n');
const tsconfig = resolve(repoRoot, 'tsconfig.json');
if (existsSync(tsconfig)) {
  const parsed = JSON.parse(readFileSync(tsconfig, 'utf-8')) as { compilerOptions?: { strict?: boolean } };
  if (parsed.compilerOptions?.strict !== true) {
    process.stdout.write('FAIL: tsconfig.json missing "strict": true\n');
    process.exit(1);
  }
  process.stdout.write('PASS: tsconfig.json has strict mode enabled\n');
} else {
  process.stdout.write('SKIP: No tsconfig.json found\n');
}

process.stdout.write('\nAll ast-grep rule tests passed.\n');
