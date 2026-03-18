import { resolve } from 'node:path';
import { detectRepo } from './repo-detector.js';
import { detectArgumentType, fetchIssue } from './issue-fetcher.js';
import { createTask } from './task-factory.js';
import { buildPipelineConfig } from '../config.js';
import { runPipeline } from '../pipeline.js';
import { runScript } from '../util/run-script.js';
import { createLogger } from '../util/logger.js';
import type { IssueContext, PipelineMode, TaskCreateRequest } from '../types.js';

const log = createLogger();

export interface CliOrchestratorOptions {
  /** Issue number, Linear ID, or free text. Undefined = re-entry (Phase 2). */
  argument?: string;
  mode: PipelineMode;
  dryRun: boolean;
  caseRoot: string;
}

/**
 * Standalone CLI orchestrator — Steps 0-3 as deterministic TypeScript.
 *
 * Flow:
 *   0. Detect repo from cwd
 *   1. Fetch issue context
 *   2. Derive branch, create task files
 *   3. Run baseline (bootstrap.sh)
 *   4. Dispatch to runPipeline()
 */
export async function runCliOrchestrator(options: CliOrchestratorOptions): Promise<void> {
  const { argument, mode, dryRun, caseRoot } = options;

  // --- Step 0: Detect repo ---
  process.stdout.write('Detecting repo...\n');
  const detected = await detectRepo(caseRoot);
  process.stdout.write(`  Repo: ${detected.name} (${detected.path})\n`);

  // --- Step 1: Fetch issue context ---
  let issueContext: IssueContext | undefined;

  if (argument) {
    const argType = detectArgumentType(argument);
    process.stdout.write(`  Issue type: ${argType} (${argument})\n`);

    issueContext = await fetchIssue(argType, argument, detected.project.remote);
    process.stdout.write(`  Issue: ${issueContext.title}\n`);
  } else {
    // No argument = re-entry mode (Phase 2 stub)
    process.stderr.write('Error: no issue argument provided. Re-entry mode is not yet implemented.\n');
    process.exit(1);
  }

  // --- Step 2: Create branch + task files ---
  const branchName = deriveBranchName(issueContext);
  process.stdout.write(`  Branch: ${branchName}\n`);

  // Create or checkout branch
  await ensureBranch(branchName, detected.path);

  // Create task files
  const request: TaskCreateRequest = {
    repo: detected.name,
    title: issueContext.title,
    description: issueContext.body || issueContext.title,
    issue: issueContext.issueNumber,
    issueType: issueContext.issueType,
    mode,
    trigger: { type: 'cli', user: 'local' },
  };

  const taskResult = await createTask(caseRoot, request, { issueContext, branch: branchName });
  process.stdout.write(`  Task: ${taskResult.taskId}\n`);
  process.stdout.write(`    JSON: ${taskResult.taskJsonPath}\n`);
  process.stdout.write(`    Spec: ${taskResult.taskMdPath}\n`);

  // Write .case-active marker
  const markerPath = resolve(detected.path, '.case-active');
  await Bun.write(markerPath, `${taskResult.taskId}\n`);
  log.info('wrote .case-active marker', { path: markerPath });

  // --- Step 3: Run baseline ---
  process.stdout.write('Running baseline (bootstrap.sh)...\n');
  const bootstrapScript = resolve(caseRoot, 'scripts/bootstrap.sh');
  const baseline = await runScript('bash', [bootstrapScript, detected.name], {
    cwd: caseRoot,
    timeout: 120_000,
  });

  if (baseline.exitCode !== 0) {
    process.stderr.write(`Baseline failed:\n${baseline.stdout}${baseline.stderr}\n`);
    process.stderr.write('Fix the issues above before retrying.\n');
    process.exit(1);
  }
  process.stdout.write('  Baseline passed.\n');

  // --- Step 4: Dispatch to pipeline ---
  process.stdout.write('Dispatching to pipeline...\n');
  const config = await buildPipelineConfig({
    taskJsonPath: taskResult.taskJsonPath,
    mode,
    dryRun,
  });

  await runPipeline(config);
}

/**
 * Derive a branch name from issue context.
 * Prefix from labels: feat/ for feature, fix/ for bug, chore/ for maintenance.
 * Suffix: issue-N (GitHub), ID (Linear), slug (freeform).
 */
function deriveBranchName(issue: IssueContext): string {
  const prefix = deriveBranchPrefix(issue.labels);

  switch (issue.issueType) {
    case 'github':
      return `${prefix}/issue-${issue.issueNumber}`;
    case 'linear':
      return `${prefix}/${issue.issueNumber}`;
    case 'freeform':
      return `${prefix}/${issue.issueNumber}`;
  }
}

/** Derive branch prefix from labels. Default: fix/. */
function deriveBranchPrefix(labels: string[]): string {
  const lowered = labels.map((l) => l.toLowerCase());

  if (lowered.some((l) => l.includes('feature') || l.includes('enhancement'))) return 'feat';
  if (lowered.some((l) => l.includes('chore') || l.includes('maintenance') || l.includes('docs'))) return 'chore';
  return 'fix';
}

/**
 * Create or checkout a branch.
 * If branch already exists, checkout. Otherwise, create from current HEAD.
 */
async function ensureBranch(branchName: string, repoPath: string): Promise<void> {
  // Check if branch exists
  const check = Bun.spawn(['git', 'rev-parse', '--verify', branchName], {
    cwd: repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const checkExitCode = await check.exited;

  if (checkExitCode === 0) {
    // Branch exists — checkout
    const co = Bun.spawn(['git', 'checkout', branchName], {
      cwd: repoPath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await co.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(co.stderr).text();
      throw new Error(`Failed to checkout branch ${branchName}: ${stderr.trim()}`);
    }
    log.info('checked out existing branch', { branch: branchName });
  } else {
    // Create new branch
    const create = Bun.spawn(['git', 'checkout', '-b', branchName], {
      cwd: repoPath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await create.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(create.stderr).text();
      throw new Error(`Failed to create branch ${branchName}: ${stderr.trim()}`);
    }
    log.info('created new branch', { branch: branchName });
  }
}
