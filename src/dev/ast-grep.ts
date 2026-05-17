import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '..', '..');

export function listRules(group: 'target' | 'self'): string[] {
  const dir = resolve(repoRoot, 'ast-rules', group);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yml'))
    .map((file) => join(dir, file))
    .sort();
}

export async function scanRule(rule: string, target: string): Promise<unknown[]> {
  const proc = Bun.spawn(['ast-grep', 'scan', '--rule', rule, target, '--json'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout || '[]') as unknown[];
  } catch {
    return [];
  }
}

export async function printRuleScan(rule: string, target: string): Promise<number> {
  const proc = Bun.spawn(['ast-grep', 'scan', '--rule', rule, target], {
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exited;
}

export function countLines(path: string): number {
  return readFileSync(path, 'utf-8').split(/\r?\n/).length;
}

export function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (
      full.includes('/node_modules/') ||
      full.includes('/.claude/') ||
      full.includes('/fixtures/') ||
      full.includes('/dist/')
    ) {
      continue;
    }
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (stat.isFile()) yield full;
  }
}
