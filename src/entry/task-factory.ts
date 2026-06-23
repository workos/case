import type { IssueContext, TaskCreateRequest, TaskJson } from '../types.js';
import { loadProjectsManifest, resolveRepoPath } from '../config.js';
import { buildLabels, encodeDescription, tdCreate, tdFocus } from '../state/td-client.js';
import { createLogger } from '../util/logger.js';
import { slugify } from '../util/slugify.js';

const log = createLogger();

/** Generate a canonical Case task ID from repo + timestamp + title slug. */
function generateTaskId(repo: string, title: string): string {
  const ts = Date.now().toString(36);
  const slug = slugify(title).slice(0, 30);
  return `${repo}-${ts}-${slug}`;
}

export interface TaskCreateResult {
  taskId: string;
  /** td issue handle backing the task. */
  tdId: string;
}

/** Optional enrichment passed by the CLI orchestrator. */
export interface TaskEnrichment {
  issueContext?: IssueContext;
  branch?: string;
  repoPath?: string;
}

/**
 * Create a task as a `td` issue in the target repo's `.todos/` store.
 *
 * The issue's description carries the human spec plus a hidden `case-state`
 * comment holding the authoritative {@link TaskJson} (see td-client.ts). The
 * new task is focused so re-entry (`ca` with no argument) resolves it via
 * `td current`. Returns the canonical task id and the td handle for dispatch.
 */
export async function createTask(
  caseRoot: string,
  request: TaskCreateRequest,
  enrichment?: TaskEnrichment,
): Promise<TaskCreateResult> {
  const taskId = generateTaskId(request.repo, request.title);
  const repoPath = enrichment?.repoPath ?? (await resolveTargetRepoPath(caseRoot, request.repo));

  const taskJson: TaskJson = {
    id: taskId,
    status: 'active',
    created: new Date().toISOString(),
    repo: request.repo,
    issue: request.issue,
    issueType: request.issueType ?? 'freeform',
    branch: enrichment?.branch,
    mode: request.mode ?? 'attended',
    profile: request.profile ?? 'standard',
    agents: {},
    tested: false,
    manualTested: false,
    prUrl: null,
    prNumber: null,
    checkCommand: request.checkCommand ?? null,
    checkBaseline: request.checkBaseline ?? null,
    checkTarget: request.checkTarget ?? null,
  };

  const { spec, acceptance } = buildTaskSpec(request, taskJson, enrichment?.issueContext);

  const tdId = await tdCreate(repoPath, {
    title: request.title,
    description: encodeDescription(spec, taskJson),
    acceptance,
    labels: buildLabels(taskJson),
  });
  taskJson.tdId = tdId;

  // Persist the td handle back into the embedded state, then focus the task.
  const { tdUpdate } = await import('../state/td-client.js');
  await tdUpdate(repoPath, tdId, { description: encodeDescription(spec, taskJson) });
  await tdFocus(repoPath, tdId);

  log.info('task created', {
    taskId,
    tdId,
    repo: request.repo,
    trigger: request.trigger.type,
    branch: enrichment?.branch,
    repoPath,
  });

  return { taskId, tdId };
}

async function resolveTargetRepoPath(caseRoot: string, repoName: string): Promise<string> {
  const manifest = await loadProjectsManifest(caseRoot);
  const project = manifest.repos.find((p) => p.name === repoName);
  if (!project) throw new Error(`Repo "${repoName}" not found in projects.json`);
  return resolveRepoPath(manifest.repoBasePath, project.path);
}

/**
 * Build the human spec markdown (td description body) and the acceptance
 * criteria text (td native `acceptance` field). The acceptance criteria are
 * kept in both so agents reading the rendered spec and `td` tooling both see
 * them.
 */
function buildTaskSpec(
  request: TaskCreateRequest,
  taskJson: TaskJson,
  issueContext?: IssueContext,
): { spec: string; acceptance: string } {
  const acceptance = '- [ ] Fix verified by tests\n- [ ] No regressions introduced';

  const lines: (string | false)[] = [
    `# ${request.title}`,
    '',
    `**Repo:** ${request.repo}`,
    `**Trigger:** ${request.trigger.type}`,
    `**Created:** ${taskJson.created}`,
    !!request.issue && `**Issue:** ${request.issue}`,
    !!taskJson.branch && `**Branch:** ${taskJson.branch}`,
    '',
  ];

  if (issueContext) {
    lines.push('## Issue Reference', '', `**Source:** ${issueContext.issueType} #${issueContext.issueNumber}`);
    if (issueContext.labels.length > 0) {
      lines.push(`**Labels:** ${issueContext.labels.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Description', '', request.description, '', '## Acceptance Criteria', '', acceptance, '');

  if (request.verificationScenarios) {
    lines.push('## Verification Scenarios', '', request.verificationScenarios, '');
  }
  if (request.nonGoals) {
    lines.push('## Non-Goals', '', request.nonGoals, '');
  }
  if (request.edgeCases) {
    lines.push('## Edge Cases', '', request.edgeCases, '');
  }
  if (request.evidenceExpectations !== undefined) {
    lines.push('## Evidence Expectations', '', request.evidenceExpectations, '');
  }

  const spec = lines.filter((line) => line !== false).join('\n');
  return { spec, acceptance };
}
