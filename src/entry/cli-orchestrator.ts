import { resolve } from 'node:path';
import { detectRepo } from './repo-detector.js';
import { detectArgumentType, fetchIssue } from './issue-fetcher.js';
import { findTaskByIssue, findTaskByMarker } from './task-scanner.js';
import { createTask } from './task-factory.js';
import { buildPipelineConfig } from '../config.js';
import { runPipeline } from '../pipeline.js';
import { runScript } from '../util/run-script.js';
import type { IssueContext, PipelineMode, TaskCreateRequest } from '../types.js';
import type { TaskMatch } from './task-scanner.js';

export interface CliOrchestratorOptions {
  /** Issue number, Linear ID, or free text. Undefined = re-entry via .case/active. */
  argument?: string;
  mode: PipelineMode;
  dryRun: boolean;
  /** Enable human approval gate between review and close. */
  approve?: boolean;
  /** Skip re-entry detection and create a fresh task. */
  fresh?: boolean;
  caseRoot: string;
}

/**
 * Standalone CLI orchestrator — Steps 0-3 as deterministic TypeScript.
 *
 * Flow:
 *   0. Detect repo from cwd
 *   0b. Check for existing task (re-entry)
 *   1. Fetch issue context
 *   2. Derive branch, create task files
 *   3. Run baseline (bootstrap.sh)
 *   4. Dispatch to runPipeline()
 */
export async function runCliOrchestrator(options: CliOrchestratorOptions): Promise<void> {
  const { argument, mode, dryRun, approve, fresh, caseRoot } = options;

  // --- Step 0: Detect repo ---
  process.stdout.write('Detecting repo...\n');
  const detected = await detectRepo(caseRoot);
  process.stdout.write(`  Repo: ${detected.name} (${detected.path})\n`);

  // --- Step 0b: Check for existing task (re-entry) ---
  let match: TaskMatch | null = null;

  if (!fresh) {
    if (argument) {
      const argType = detectArgumentType(argument);
      match = await findTaskByIssue(caseRoot, detected.name, argType, argument);
    } else {
      match = await findTaskByMarker(caseRoot, detected.path);
    }
  }

  if (match) {
    return resumeTask(match, detected.path, mode, dryRun, approve);
  }

  // No existing task found — create new or exit
  if (!argument) {
    process.stdout.write('No active task found. Usage: bun src/index.ts <issue-number>\n');
    return;
  }

  // --- Step 1: Fetch issue context ---
  const argType = detectArgumentType(argument);
  process.stdout.write(`  Issue type: ${argType} (${argument})\n`);

  const issueContext: IssueContext = await fetchIssue(argType, argument, detected.project.remote);
  process.stdout.write(`  Issue: ${issueContext.title}\n`);

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

  // Write .case/active marker (mkdir -p equivalent)
  const caseDirPath = resolve(detected.path, '.case');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(caseDirPath, { recursive: true });
  await Bun.write(resolve(caseDirPath, 'active'), `${taskResult.taskId}\n`);

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
    approve,
  });

  await runPipeline(config);
}

/**
 * Resume an existing task from the correct pipeline phase.
 * Handles terminal states (pr-opened, ideation) and branch recovery.
 */
async function resumeTask(match: TaskMatch, repoPath: string, mode: PipelineMode, dryRun: boolean, approve?: boolean): Promise<void> {
  const { taskJson, taskJsonPath, entryPhase } = match;

  // Guard: task already has a PR open
  if (taskJson.status === 'pr-opened' || taskJson.status === 'merged') {
    const prInfo = taskJson.prUrl ? `: ${taskJson.prUrl}` : '';
    process.stdout.write(`PR already exists${prInfo}. Nothing to do.\n`);
    return;
  }

  // Guard: ideation tasks need a different workflow
  if (taskJson.issueType === 'ideation') {
    process.stdout.write(`This is an ideation task. Resume with: /case:from-ideation ${taskJsonPath}\n`);
    return;
  }

  process.stdout.write(`Resuming task ${taskJson.id} from ${entryPhase} phase\n`);

  // Checkout the task's branch if it has one
  if (taskJson.branch) {
    await ensureBranch(taskJson.branch, repoPath, true);
  }

  // Build config from existing task JSON and dispatch
  const config = await buildPipelineConfig({
    taskJsonPath,
    mode,
    dryRun,
    approve,
  });

  process.stdout.write('Dispatching to pipeline...\n');
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
 * Create or checkout a git branch.
 * If branch exists, checkout. Otherwise, create from HEAD.
 * When `warnOnCreate` is true (resume flow), warns that the branch was recreated.
 */
async function ensureBranch(branchName: string, repoPath: string, warnOnCreate = false): Promise<void> {
  const check = await runScript('git', ['rev-parse', '--verify', branchName], { cwd: repoPath });

  if (check.exitCode === 0) {
    const co = await runScript('git', ['checkout', branchName], { cwd: repoPath });
    if (co.exitCode !== 0) {
      throw new Error(`Failed to checkout branch ${branchName}: ${co.stderr.trim()}`);
    }
  } else {
    if (warnOnCreate) {
      process.stdout.write(`  Warning: branch ${branchName} not found, recreating from HEAD\n`);
    }
    const create = await runScript('git', ['checkout', '-b', branchName], { cwd: repoPath });
    if (create.exitCode !== 0) {
      throw new Error(`Failed to create branch ${branchName}: ${create.stderr.trim()}`);
    }
  }
}
