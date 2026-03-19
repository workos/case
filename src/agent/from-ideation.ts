import { resolve, basename } from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { spawnAgent } from './pi-runner.js';
import { createTask } from '../entry/task-factory.js';
import { runScript } from '../util/run-script.js';
import { loadSystemPrompt } from './prompt-loader.js';
import type { FromIdeationOptions, PhaseResult, AgentResult, TaskCreateRequest, TaskJson } from '../types.js';

interface ContractInfo {
  problemStatement: string;
  goals: string;
  successCriteria: string;
  specFiles: string[]; // sorted by phase number
}

interface FromIdeationResult {
  success: boolean;
  phases: PhaseResult[];
  prUrl: string | null;
  error: string | null;
}

/**
 * Load and parse a contract.md file from an ideation folder.
 * Extracts problem statement, goals, and success criteria sections.
 */
export async function loadContract(ideationFolder: string): Promise<ContractInfo> {
  const contractPath = resolve(ideationFolder, 'contract.md');
  let raw: string;
  try {
    raw = await readFile(contractPath, 'utf-8');
  } catch {
    throw new Error(`No contract.md found in ${ideationFolder}`);
  }

  const specFiles = await discoverSpecs(ideationFolder);

  return {
    problemStatement: extractSection(raw, 'Problem Statement') || extractSection(raw, 'Problem') || '',
    goals: extractSection(raw, 'Goals') || '',
    successCriteria: extractSection(raw, 'Success Criteria') || '',
    specFiles,
  };
}

/**
 * Discover spec files in an ideation folder.
 * Handles both single-phase (spec.md) and multi-phase (spec-phase-N.md) projects.
 * Returns absolute paths sorted by phase number.
 */
export async function discoverSpecs(ideationFolder: string): Promise<string[]> {
  const absFolder = resolve(ideationFolder);
  let entries: string[];
  try {
    entries = await readdir(absFolder);
  } catch {
    throw new Error(`No spec files found in ${ideationFolder}`);
  }

  const specEntries: Array<{ path: string; phase: number }> = [];

  for (const entry of entries) {
    if (entry === 'spec.md') {
      specEntries.push({ path: resolve(absFolder, entry), phase: 0 });
    } else {
      const match = entry.match(/^spec-phase-(\d+)\.md$/);
      if (match) {
        specEntries.push({ path: resolve(absFolder, entry), phase: parseInt(match[1], 10) });
      }
    }
  }

  if (specEntries.length === 0) {
    throw new Error(`No spec files found in ${ideationFolder}`);
  }

  specEntries.sort((a, b) => a.phase - b.phase);
  return specEntries.map((e) => e.path);
}

/**
 * Execute an ideation contract through the case pipeline.
 *
 * Flow: load contract → check re-entry → create task → branch & baseline
 *       → per-phase implementer → validation → verifier → reviewer → closer
 */
export async function executeFromIdeation(options: FromIdeationOptions): Promise<FromIdeationResult> {
  const { ideationFolder, caseRoot, repoName, repoPath, onProgress } = options;
  const phases: PhaseResult[] = [];

  // --- Load contract ---
  onProgress?.('Loading contract...');
  let contract: ContractInfo;
  try {
    contract = await loadContract(ideationFolder);
  } catch (err) {
    return { success: false, phases, prUrl: null, error: (err as Error).message };
  }

  if (contract.specFiles.length === 0) {
    return { success: false, phases, prUrl: null, error: `No spec files found in ${ideationFolder}` };
  }

  // --- Filter to specific phase if requested ---
  const specsToExecute = options.phase
    ? contract.specFiles.filter((_, i) => i + 1 === options.phase)
    : contract.specFiles;

  if (specsToExecute.length === 0) {
    return {
      success: false,
      phases,
      prUrl: null,
      error: `Phase ${options.phase} not found (${contract.specFiles.length} phases available)`,
    };
  }

  // --- Check re-entry ---
  const contractPath = resolve(ideationFolder, 'contract.md');
  const existingTask = await findTaskByContractPath(caseRoot, contractPath);

  if (existingTask) {
    if (existingTask.prUrl) {
      return { success: true, phases, prUrl: existingTask.prUrl, error: null };
    }
    // TODO: Resume from correct phase. For now, report existing task.
    return {
      success: false,
      phases,
      prUrl: null,
      error: `Existing task ${existingTask.id} found (status: ${existingTask.status}). Re-entry not yet supported in tool mode.`,
    };
  }

  // --- Derive project name and branch ---
  const projectName = basename(resolve(ideationFolder));
  const branchName = `feat/${projectName}`;

  // --- Create task ---
  onProgress?.('Creating task...');
  const request: TaskCreateRequest = {
    repo: repoName,
    title: `Ideation: ${projectName}`,
    description: contract.problemStatement || contract.goals,
    issueType: 'ideation',
    mode: 'attended',
    trigger: { type: 'cli', user: 'local' },
  };

  let taskJsonPath: string;
  try {
    const taskResult = await createTask(caseRoot, request, { branch: branchName });
    taskJsonPath = taskResult.taskJsonPath;

    // Write contractPath to task JSON
    const taskJsonRaw = await readFile(taskJsonPath, 'utf-8');
    const taskJson = JSON.parse(taskJsonRaw) as TaskJson;
    taskJson.contractPath = contractPath;
    await writeFile(taskJsonPath, JSON.stringify(taskJson, null, 2) + '\n');
  } catch (err) {
    return { success: false, phases, prUrl: null, error: `Task creation failed: ${(err as Error).message}` };
  }

  // --- Branch & baseline ---
  onProgress?.('Setting up branch and running baseline...');
  try {
    await ensureBranch(branchName, repoPath);
  } catch (err) {
    return { success: false, phases, prUrl: null, error: `Branch setup failed: ${(err as Error).message}` };
  }

  const bootstrapScript = resolve(caseRoot, 'scripts/bootstrap.sh');
  const baseline = await runScript('bash', [bootstrapScript, repoName], {
    cwd: caseRoot,
    timeout: 120_000,
  });

  if (baseline.exitCode !== 0) {
    return {
      success: false,
      phases,
      prUrl: null,
      error: `Baseline failed:\n${baseline.stdout}${baseline.stderr}`,
    };
  }

  // --- Execute phases ---
  const implementerPrompt = await loadSystemPrompt(caseRoot, 'implementer');

  for (let i = 0; i < specsToExecute.length; i++) {
    const specFile = specsToExecute[i];
    const phaseNum = options.phase ?? i + 1;

    onProgress?.(`Executing phase ${phaseNum} of ${contract.specFiles.length}...`);

    const phaseResult = await executePhase({
      specFile,
      phase: phaseNum,
      totalPhases: contract.specFiles.length,
      taskJsonPath,
      repoPath,
      caseRoot,
      implementerPrompt,
      completedPhases: phases.filter((p) => p.status === 'completed'),
    });

    phases.push(phaseResult);

    if (phaseResult.status === 'failed') {
      return {
        success: false,
        phases,
        prUrl: null,
        error: `Phase ${phaseNum} failed: ${phaseResult.error}`,
      };
    }
  }

  // --- Post-implementation pipeline: verifier → reviewer → closer ---
  onProgress?.('Running verifier...');
  const verifierResult = await spawnPipelineAgent('verifier', taskJsonPath, repoPath, caseRoot);
  if (verifierResult.status !== 'completed') {
    return {
      success: false,
      phases,
      prUrl: null,
      error: `Verifier failed: ${verifierResult.error}`,
    };
  }

  onProgress?.('Running reviewer...');
  const reviewerResult = await spawnPipelineAgent('reviewer', taskJsonPath, repoPath, caseRoot);
  if (reviewerResult.status === 'blocked') {
    return {
      success: false,
      phases,
      prUrl: null,
      error: `Reviewer blocked: ${reviewerResult.summary}`,
    };
  }

  onProgress?.('Creating PR...');
  const closerResult = await spawnPipelineAgent('closer', taskJsonPath, repoPath, caseRoot);
  if (closerResult.status !== 'completed') {
    return {
      success: false,
      phases,
      prUrl: null,
      error: `Closer failed: ${closerResult.error}`,
    };
  }

  return {
    success: true,
    phases,
    prUrl: closerResult.artifacts.prUrl,
    error: null,
  };
}

// --- Internal helpers ---

interface PhaseExecutionOptions {
  specFile: string;
  phase: number;
  totalPhases: number;
  taskJsonPath: string;
  repoPath: string;
  caseRoot: string;
  implementerPrompt: string;
  completedPhases: PhaseResult[];
}

async function executePhase(options: PhaseExecutionOptions): Promise<PhaseResult> {
  const { specFile, phase, totalPhases, taskJsonPath, repoPath, caseRoot, implementerPrompt, completedPhases } =
    options;
  const taskMdPath = taskJsonPath.replace(/\.task\.json$/, '.md');

  try {
    const specContent = await readFile(specFile, 'utf-8');

    const previousPhasesSummary =
      completedPhases.length > 0
        ? completedPhases.map((p) => `Phase ${p.phase}: ${p.summary} (${p.commit})`).join('\n')
        : 'none';

    const prompt = `${implementerPrompt}

## Task Context

- **Task file**: ${taskMdPath}
- **Task JSON**: ${taskJsonPath}
- **Target repo**: ${repoPath}
- **Playbook**: ${caseRoot}/docs/playbooks/implement-from-spec.md
- **Spec file**: ${specFile}
- **Phase**: ${phase} of ${totalPhases}
- **Previous phases**: ${previousPhasesSummary}

Read the playbook first. It tells you how to consume the spec file —
feedback loops, component-by-component implementation, validation commands.
The spec file is your implementation guide, not an issue or bug report.

## Spec Content

${specContent}`;

    const { result } = await spawnAgent({
      prompt,
      cwd: repoPath,
      agentName: 'implementer',
      caseRoot,
      timeout: 600_000,
    });

    return {
      phase,
      specFile,
      status: result.status === 'completed' ? 'completed' : 'failed',
      commit: result.artifacts.commit,
      summary: result.summary,
      error: result.error,
    };
  } catch (err) {
    return {
      phase,
      specFile,
      status: 'failed',
      commit: null,
      summary: '',
      error: (err as Error).message,
    };
  }
}

async function spawnPipelineAgent(
  agentName: 'verifier' | 'reviewer' | 'closer',
  taskJsonPath: string,
  repoPath: string,
  caseRoot: string,
): Promise<AgentResult> {
  const taskMdPath = taskJsonPath.replace(/\.task\.json$/, '.md');

  try {
    const agentPrompt = await loadSystemPrompt(caseRoot, agentName);
    const prompt = `${agentPrompt}

## Task Context

- **Task file**: ${taskMdPath}
- **Task JSON**: ${taskJsonPath}
- **Target repo**: ${repoPath}`;

    const { result } = await spawnAgent({
      prompt,
      cwd: repoPath,
      agentName,
      caseRoot,
      timeout: 600_000,
    });

    return result;
  } catch (err) {
    return {
      status: 'failed',
      summary: `${agentName} agent threw: ${(err as Error).message}`,
      artifacts: {
        commit: null,
        filesChanged: [],
        testsPassed: null,
        screenshotUrls: [],
        evidenceMarkers: [],
        prUrl: null,
        prNumber: null,
      },
      error: (err as Error).message,
    };
  }
}

/**
 * Find an existing task by contractPath in tasks/active/.
 */
async function findTaskByContractPath(caseRoot: string, contractPath: string): Promise<TaskJson | null> {
  const activeDir = resolve(caseRoot, 'tasks/active');

  let entries: string[];
  try {
    entries = await readdir(activeDir);
  } catch {
    return null;
  }

  for (const file of entries.filter((f) => f.endsWith('.task.json'))) {
    try {
      const raw = await readFile(resolve(activeDir, file), 'utf-8');
      const task = JSON.parse(raw) as TaskJson;
      if (task.contractPath === contractPath) {
        return task;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Extract a markdown section by heading name.
 * Returns the content between the heading and the next same-level heading.
 */
function extractSection(markdown: string, heading: string): string | null {
  const regex = new RegExp(`^##\\s+${heading}\\s*$`, 'mi');
  const match = regex.exec(markdown);
  if (!match) return null;

  const start = match.index + match[0].length;
  const nextHeading = markdown.indexOf('\n## ', start);
  const content = nextHeading === -1 ? markdown.slice(start) : markdown.slice(start, nextHeading);
  return content.trim();
}

/**
 * Create or checkout a git branch.
 * Uses runScript to stay within the mocked I/O boundary.
 */
async function ensureBranch(branchName: string, repoPath: string): Promise<void> {
  const check = await runScript('git', ['rev-parse', '--verify', branchName], { cwd: repoPath });

  if (check.exitCode === 0) {
    const co = await runScript('git', ['checkout', branchName], { cwd: repoPath });
    if (co.exitCode !== 0) {
      throw new Error(`Failed to checkout branch ${branchName}: ${co.stderr.trim()}`);
    }
  } else {
    const create = await runScript('git', ['checkout', '-b', branchName], { cwd: repoPath });
    if (create.exitCode !== 0) {
      throw new Error(`Failed to create branch ${branchName}: ${create.stderr.trim()}`);
    }
  }
}
