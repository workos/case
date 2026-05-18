import { detectRepo } from './repo-detector.js';
import { detectArgumentType, fetchIssue } from './issue-fetcher.js';
import { findTaskByIssue, findTaskByMarker } from './task-scanner.js';
import { createTask } from './task-factory.js';
import { buildPipelineConfig } from '../config.js';
import { runPipeline } from '../pipeline.js';
import { runBootstrap } from '../commands/bootstrap.js';
import { runCommand } from '../util/run-command.js';
import { createStructuredLogRenderer } from '../render/structured-log.js';
import { formatSetupStep } from '../render/format.js';
import type { Notifier } from '../notify.js';
import type { IssueContext, PipelineMode, PipelinePhase, TaskCreateRequest } from '../types.js';
import type { TaskMatch } from './task-scanner.js';

export interface CliOrchestratorOptions {
  /** Issue number, Linear ID, or free text. Undefined = re-entry via .case/active. */
  argument?: string;
  mode: PipelineMode;
  dryRun: boolean;
  /** Skip re-entry detection and create a fresh task. */
  fresh?: boolean;
  caseRoot: string;
  /** Renderer override: 'tui' for full-screen TUI mode. */
  renderer?: 'structured' | 'tui';
}

const SETUP_PHASE: PipelinePhase = 'setup';

/**
 * Emit a setup-phase tool line via the notifier. We bypass the Notifier's
 * toolStart implementation (which uses `formatToolLine`) because setup steps
 * don't need a duration suffix — `formatSetupStep` gives us the right shape.
 */
function setupStep(notifier: Notifier, label: string, detail?: string): void {
  notifier.send(formatSetupStep(label, detail));
}

/**
 * Standalone CLI orchestrator — Steps 0-3 as deterministic TypeScript.
 *
 * Flow:
 *   0. Detect repo from cwd
 *   0b. Check for existing task (re-entry)
 *   1. Fetch issue context
 *   2. Derive branch, create task files
 *   3. Run baseline
 *   4. Dispatch to runPipeline()
 */
export async function runCliOrchestrator(options: CliOrchestratorOptions): Promise<void> {
  const { argument, mode, dryRun, fresh, caseRoot, renderer } = options;

  const notifier = createStructuredLogRenderer({ mode });
  const setupStartedAt = Date.now();
  notifier.phaseStart(SETUP_PHASE, 'cli');

  // --- Step 0: Detect repo ---
  const detected = await detectRepo(caseRoot);
  setupStep(notifier, 'Detect repo', detected.name);

  // --- Step 0b: Check for existing task (re-entry) ---
  let match: TaskMatch | null = null;

  if (!fresh) {
    if (argument) {
      const argType = detectArgumentType(argument);
      match = await findTaskByIssue(caseRoot, detected.name, argType, argument, detected.path);
    } else {
      match = await findTaskByMarker(caseRoot, detected.path);
    }
  }

  if (match) {
    return resumeTask(match, detected.path, mode, dryRun, notifier, setupStartedAt, renderer);
  }

  // No existing task found — create new or exit
  if (!argument) {
    notifier.phaseEnd(SETUP_PHASE, 'cli', Date.now() - setupStartedAt, 'failed');
    notifier.send('No active task found. Usage: bun src/index.ts <issue-number>');
    return;
  }

  // --- Step 1: Fetch issue context ---
  const argType = detectArgumentType(argument);
  setupStep(notifier, 'Issue type', `${argType} (${argument})`);

  const issueContext: IssueContext = await fetchIssue(argType, argument, detected.project.remote);
  setupStep(notifier, 'Fetch issue', issueContext.title);

  // --- Step 2: Create branch + task files ---
  const branchName = deriveBranchName(issueContext);
  setupStep(notifier, 'Branch', branchName);

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

  const taskResult = await createTask(caseRoot, request, { issueContext, branch: branchName, repoPath: detected.path });
  setupStep(notifier, 'Task', taskResult.taskId);

  // --- Step 3: Run baseline ---
  const baseline = await runBootstrap(detected.name, caseRoot);

  if (!baseline.ok) {
    const failed = baseline.steps.find((step) => step.exitCode !== 0);
    setupStep(notifier, 'Baseline', 'failed');
    notifier.phaseEnd(SETUP_PHASE, 'cli', Date.now() - setupStartedAt, 'failed');
    process.stderr.write(`Baseline failed:\n${failed?.output ?? ''}\n`);
    process.stderr.write('Fix the issues above before retrying.\n');
    process.exit(1);
  }
  setupStep(notifier, 'Baseline', 'passed');

  notifier.phaseEnd(SETUP_PHASE, 'cli', Date.now() - setupStartedAt, 'completed');

  // --- Step 4: Dispatch to pipeline ---
  const config = await buildPipelineConfig({
    taskJsonPath: taskResult.taskJsonPath,
    mode,
    dryRun,
  });

  await runPipeline({ ...config, notifier, renderer });
}

/**
 * Resume an existing task from the correct pipeline phase.
 * Handles terminal states (pr-opened) and branch recovery.
 */
async function resumeTask(
  match: TaskMatch,
  repoPath: string,
  mode: PipelineMode,
  dryRun: boolean,
  notifier: Notifier,
  setupStartedAt: number,
  renderer?: 'structured' | 'tui',
): Promise<void> {
  const { taskJson, taskJsonPath, entryPhase } = match;

  // Guard: task already has a PR open
  if (taskJson.status === 'pr-opened' || taskJson.status === 'merged') {
    const prInfo = taskJson.prUrl ? `: ${taskJson.prUrl}` : '';
    setupStep(notifier, 'Status', `${taskJson.status}${prInfo}`);
    notifier.phaseEnd(SETUP_PHASE, 'cli', Date.now() - setupStartedAt, 'completed');
    notifier.send(`PR already exists${prInfo}. Nothing to do.`);
    return;
  }

  setupStep(notifier, 'Resume task', `${taskJson.id} (entry: ${entryPhase})`);

  // Checkout the task's branch if it has one
  if (taskJson.branch) {
    await ensureBranch(taskJson.branch, repoPath, true);
    setupStep(notifier, 'Branch', taskJson.branch);
  }

  // Build config from existing task JSON and dispatch
  const config = await buildPipelineConfig({
    taskJsonPath,
    mode,
    dryRun,
  });

  notifier.phaseEnd(SETUP_PHASE, 'cli', Date.now() - setupStartedAt, 'completed');

  await runPipeline({ ...config, notifier, renderer });
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
  const check = await runCommand('git', ['rev-parse', '--verify', branchName], { cwd: repoPath });

  if (check.exitCode === 0) {
    const co = await runCommand('git', ['checkout', branchName], { cwd: repoPath });
    if (co.exitCode !== 0) {
      throw new Error(`Failed to checkout branch ${branchName}: ${co.stderr.trim()}`);
    }
  } else {
    if (warnOnCreate) {
      process.stdout.write(`  Warning: branch ${branchName} not found, recreating from HEAD\n`);
    }
    const create = await runCommand('git', ['checkout', '-b', branchName], { cwd: repoPath });
    if (create.exitCode !== 0) {
      throw new Error(`Failed to create branch ${branchName}: ${create.stderr.trim()}`);
    }
  }
}
