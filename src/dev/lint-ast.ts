import { basename, resolve } from 'node:path';
import { listRules, repoRoot, scanRule } from './ast-grep.js';

const group = process.argv[2] as 'target' | 'self' | undefined;
const target = process.argv[3];

if (group !== 'target' && group !== 'self') {
  process.stderr.write('Usage: bun src/dev/lint-ast.ts <target|self> <path>\n');
  process.exit(1);
}

if (!target) {
  process.stderr.write('Usage: bun src/dev/lint-ast.ts <target|self> <path>\n');
  process.exit(1);
}

let failed = false;
for (const rule of listRules(group)) {
  const matches = await scanRule(rule, resolve(repoRoot, target));
  if (matches.length > 0) {
    failed = true;
    process.stdout.write(`${basename(rule, '.yml')}: ${matches.length} finding(s)\n`);
    const proc = Bun.spawn(['ast-grep', 'scan', '--rule', rule, target], {
      cwd: repoRoot,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await proc.exited;
  }
}

if (failed) process.exit(1);
