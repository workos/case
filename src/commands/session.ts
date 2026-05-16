import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const description = 'Print session context (git branch, task file, repo info)';

async function run(cmd: string[], cwd?: string): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } catch {
    return '';
  }
}

async function runOk(cmd: string[], cwd?: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function handler(argv: string[]): Promise<number> {
  let repoPath = argv[0] || '.';
  let taskJsonPath = '';
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--task' && argv[i + 1]) {
      taskJsonPath = argv[i + 1]!;
      i++;
    }
  }
  const ctx = await gatherSessionContext(resolve(repoPath), taskJsonPath || undefined);
  process.stdout.write(JSON.stringify(ctx, null, 2) + '\n');
  return 0;
}

/** Programmatic API — returns session context as a structured object. */
export async function gatherSessionContext(repoPath: string, taskJsonPath?: string): Promise<Record<string, unknown>> {
  repoPath = resolve(repoPath);
  const branch = (await run(['git', 'branch', '--show-current'], repoPath)) || 'detached';
  const onMain = branch === 'main' || branch === 'master';
  const lastCommit = await run(['git', 'log', '--oneline', '-1'], repoPath);
  const hasStagedChanges = !(await runOk(['git', 'diff', '--cached', '--quiet'], repoPath));
  const hasUnstagedChanges = !(await runOk(['git', 'diff', '--quiet'], repoPath));
  const recentRaw = await run(['git', 'log', '--oneline', '-5'], repoPath);
  const recentCommits = recentRaw.split('\n').filter(Boolean);

  const caseDir = resolve(repoPath, '.case');
  const activeFile = resolve(caseDir, 'active');
  let caseActive = false;
  let caseTested = false;
  let caseManualTested = false;
  let caseReviewed = false;
  if (existsSync(activeFile)) {
    caseActive = true;
    const taskSlug = readFileSync(activeFile, 'utf-8').trim();
    if (taskSlug) {
      const slugDir = resolve(caseDir, taskSlug);
      caseTested = existsSync(resolve(slugDir, 'tested'));
      caseManualTested = existsSync(resolve(slugDir, 'manual-tested'));
      caseReviewed = existsSync(resolve(slugDir, 'reviewed'));
    }
  }

  const nodeVersion = (await run(['node', '--version'])) || 'not found';
  const pnpmVersion = (await run(['pnpm', '--version'])) || 'not found';

  let task: Record<string, unknown> | null = null;
  if (taskJsonPath) {
    try {
      const raw = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
      task = {
        id: raw.id ?? null,
        status: raw.status ?? null,
        tested: raw.tested ?? false,
        manual_tested: raw.manualTested ?? false,
        agents: raw.agents ?? {},
      };
    } catch (e: unknown) {
      task = { error: `could not read task file: ${(e as Error).message}` };
    }
  }

  return {
    repo: {
      path: repoPath,
      branch,
      on_main: onMain,
      last_commit: lastCommit,
      uncommitted_changes: hasStagedChanges || hasUnstagedChanges,
      recent_commits: recentCommits,
    },
    task,
    evidence: {
      case_tested: caseTested,
      case_manual_tested: caseManualTested,
      case_reviewed: caseReviewed,
      case_active: caseActive,
    },
    environment: { node_version: nodeVersion, pnpm_version: pnpmVersion },
  };
}
