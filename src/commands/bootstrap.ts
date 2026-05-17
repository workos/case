import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadProjects, resolveRepoPath } from '../config.js';
import { resolvePackageRoot } from '../paths.js';
import { runCommandLine } from '../util/run-command.js';
import type { ProjectEntry } from '../types.js';

export const description = 'Verify a target repo is ready for agent work';

interface StepResult {
  label: string;
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface BootstrapResult {
  repo: ProjectEntry;
  repoPath: string;
  steps: StepResult[];
  totalDurationMs: number;
  ok: boolean;
}

export async function runBootstrap(repoName: string, caseRoot = resolvePackageRoot()): Promise<BootstrapResult> {
  const projects = await loadProjects(caseRoot);
  const repo = projects.find((p) => p.name === repoName);
  if (!repo) {
    throw new Error(
      `repo '${repoName}' not found in projects.json. Available repos: ${projects.map((p) => p.name).join(', ')}`,
    );
  }

  const repoPath = resolveRepoPath(caseRoot, repo.path);
  if (!existsSync(repoPath)) {
    throw new Error(`repo directory not found at ${repo.path} (resolved from ${caseRoot})`);
  }

  ensureCaseIgnored(repoPath);

  const steps: StepResult[] = [];
  let ok = true;

  for (const key of ['setup', 'test', 'build'] as const) {
    const command = repo.commands?.[key];
    if (!command) continue;
    if (!ok) break;

    const start = Date.now();
    const result = await runCommandLine(command, { cwd: repoPath, timeout: 120_000 });
    const output = `${result.stdout}${result.stderr}`.trim();
    const step = {
      label: `${key}: ${command}`,
      command,
      exitCode: result.exitCode,
      durationMs: Date.now() - start,
      output,
    };
    steps.push(step);
    if (result.exitCode !== 0) ok = false;
  }

  return {
    repo,
    repoPath,
    steps,
    totalDurationMs: steps.reduce((sum, step) => sum + step.durationMs, 0),
    ok,
  };
}

export async function handler(argv: string[]): Promise<number> {
  const repoName = argv[0];
  const caseRoot = resolvePackageRoot();
  if (!repoName || repoName === '--help' || repoName === '-h') {
    const projects = await loadProjects(caseRoot).catch(() => []);
    process.stderr.write('Usage: ca bootstrap <repo-name>\n');
    if (projects.length > 0) {
      process.stderr.write('\nAvailable repos:\n');
      for (const project of projects) process.stderr.write(`  ${project.name}\n`);
    }
    return repoName ? 0 : 1;
  }

  let result: BootstrapResult;
  try {
    result = await runBootstrap(repoName, caseRoot);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }

  process.stdout.write(`Bootstrapping ${result.repo.name} (${result.repo.path})...\n`);
  for (const step of result.steps) {
    const seconds = (step.durationMs / 1000).toFixed(1);
    if (step.exitCode === 0) {
      process.stdout.write(`  [OK] ${step.label} (${seconds}s)\n`);
    } else {
      process.stdout.write(`  [FAIL] ${step.label} (${seconds}s)\n`);
      process.stdout.write('         Output (last 10 lines):\n');
      for (const line of lastLines(step.output, 10)) {
        process.stdout.write(`         ${line}\n`);
      }
    }
  }

  const totalSeconds = (result.totalDurationMs / 1000).toFixed(1);
  process.stdout.write(result.ok ? `Ready. Total: ${totalSeconds}s\n` : `Not ready. Total: ${totalSeconds}s\n`);
  return result.ok ? 0 : 1;
}

function ensureCaseIgnored(repoPath: string): void {
  const gitignore = `${repoPath}/.gitignore`;
  if (!existsSync(gitignore)) return;

  const current = readFileSync(gitignore, 'utf-8');
  if (current.split(/\r?\n/).some((line) => line.trim() === '.case/')) return;

  const prefix = current.endsWith('\n') ? '' : '\n';
  writeFileSync(gitignore, `${current}${prefix}\n# Case harness markers\n.case/\n`);
}

function lastLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - count)).map((line) => line.slice(0, 500));
}
