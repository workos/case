import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repoRoot, walk } from './ast-grep.js';

const files = [
  ...[...walk(resolve(repoRoot, 'agents'))].filter((file) => file.endsWith('.md')),
  join(repoRoot, 'AGENTS.md'),
  join(repoRoot, 'CLAUDE.md'),
  join(repoRoot, 'README.md'),
].filter((file) => existsSync(file));

const absoluteUserPathPrefix = ['', 'Users', ''].join('/');
let failed = false;
for (const file of files) {
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(absoluteUserPathPrefix)) {
      failed = true;
      process.stdout.write(`ERROR: hardcoded path in ${file}:${i + 1}: ${lines[i]}\n`);
    }
  }
}

if (failed) {
  process.stdout.write('FAIL: hardcoded absolute user paths found in agent/root docs\n');
  process.exit(1);
}

process.stdout.write('PASS: no hardcoded absolute user paths in agent/root docs\n');
