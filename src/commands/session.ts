import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeState, tdCurrent, tdShow } from '../state/td-client.js';

export const description = 'Print session context (git branch, current task, repo info)';

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
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stderr.write('Usage: ca session <repo-path> [--task <td-id>]\n');
    return 0;
  }

  const repoPath = argv[0] || '.';
  let tdId = '';
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--task' && argv[i + 1]) {
      tdId = argv[i + 1]!;
      i++;
    }
  }
  const ctx = await gatherSessionContext(resolve(repoPath), tdId || undefined);
  process.stdout.write(JSON.stringify(ctx, null, 2) + '\n');
  return 0;
}

/**
 * Programmatic API — returns session context as a structured object.
 *
 * `tdId` selects an explicit task; when omitted the repo's focused task (via
 * `td current`) is used. Evidence markers still live under `.case/<taskId>/`.
 */
export async function gatherSessionContext(repoPath: string, tdId?: string): Promise<Record<string, unknown>> {
  repoPath = resolve(repoPath);
  const branch = (await run(['git', 'branch', '--show-current'], repoPath)) || 'detached';
  const onMain = branch === 'main' || branch === 'master';
  const lastCommit = await run(['git', 'log', '--oneline', '-1'], repoPath);
  const hasStagedChanges = !(await runOk(['git', 'diff', '--cached', '--quiet'], repoPath));
  const hasUnstagedChanges = !(await runOk(['git', 'diff', '--quiet'], repoPath));
  const recentRaw = await run(['git', 'log', '--oneline', '-5'], repoPath);
  const recentCommits = recentRaw.split('\n').filter(Boolean);

  const caseDir = resolve(repoPath, '.case');

  // Resolve the active task from td: an explicit handle, else the focused one.
  const activeTdId = tdId ?? (await tdCurrent(repoPath));
  let caseActive = false;
  let caseTested = false;
  let caseManualTested = false;
  let caseReviewed = false;
  let task: Record<string, unknown> | null = null;

  if (activeTdId) {
    const issue = await tdShow(repoPath, activeTdId);
    const state = issue ? decodeState(issue.description) : null;
    if (state) {
      caseActive = true;
      const slugDir = resolve(caseDir, state.id);
      caseTested = existsSync(resolve(slugDir, 'tested'));
      caseManualTested = existsSync(resolve(slugDir, 'manual-tested'));
      caseReviewed = existsSync(resolve(slugDir, 'reviewed'));
      task = {
        id: state.id ?? null,
        td_id: activeTdId,
        status: state.status ?? null,
        tested: state.tested ?? false,
        manual_tested: state.manualTested ?? false,
        agents: state.agents ?? {},
      };
    } else if (tdId) {
      task = { error: `could not read td task: ${activeTdId}` };
    }
  }

  const nodeVersion = (await run(['node', '--version'])) || 'not found';
  const pnpmVersion = (await run(['pnpm', '--version'])) || 'not found';

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
