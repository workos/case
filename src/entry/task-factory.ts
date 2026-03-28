import { mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import type { IssueContext, TaskCreateRequest, TaskJson } from '../types.js';
import { createLogger } from '../util/logger.js';
import { slugify } from '../util/slugify.js';

const log = createLogger();

/** Generate a task ID from repo + timestamp + title slug. */
function generateTaskId(repo: string, title: string): string {
  const ts = Date.now().toString(36);
  const slug = slugify(title).slice(0, 30);
  return `${repo}-${ts}-${slug}`;
}

export interface TaskCreateResult {
  taskId: string;
  taskJsonPath: string;
  taskMdPath: string;
}

/** Optional enrichment passed by the CLI orchestrator. */
export interface TaskEnrichment {
  issueContext?: IssueContext;
  branch?: string;
}

/**
 * Create a task.json + task.md pair in tasks/active/ from a TaskCreateRequest.
 * Returns paths to the created files for pipeline dispatch.
 *
 * When `enrichment` is provided (from CLI orchestrator), the task gets:
 * - `branch` field in JSON
 * - Richer markdown with issue reference and labels
 */
const DONE_CONTRACT_FIELDS = ['verificationScenarios', 'nonGoals', 'edgeCases', 'evidenceExpectations'] as const;

export async function createTask(
  caseRoot: string,
  request: TaskCreateRequest,
  enrichment?: TaskEnrichment,
): Promise<TaskCreateResult> {
  // Complex profile requires all done contract sections
  if (request.profile === 'complex') {
    const missing = DONE_CONTRACT_FIELDS.filter((f) => !request[f]);
    if (missing.length > 0) {
      throw new Error(`complex profile requires done contract fields: ${missing.join(', ')}`);
    }
  }

  const taskId = generateTaskId(request.repo, request.title);
  const activeDir = resolve(caseRoot, 'tasks/active');
  await mkdir(activeDir, { recursive: true });

  const taskJsonPath = resolve(activeDir, `${taskId}.task.json`);
  const taskMdPath = resolve(activeDir, `${taskId}.md`);

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

  const taskMd = buildTaskMarkdown(request, taskJson, enrichment?.issueContext);

  await Bun.write(taskJsonPath, JSON.stringify(taskJson, null, 2) + '\n');
  await Bun.write(taskMdPath, taskMd);

  log.info('task created', {
    taskId,
    repo: request.repo,
    trigger: request.trigger.type,
    branch: enrichment?.branch,
    file: basename(taskJsonPath),
  });

  return { taskId, taskJsonPath, taskMdPath };
}

/** Build task markdown. Enriched with issue context when available. */
function buildTaskMarkdown(request: TaskCreateRequest, taskJson: TaskJson, issueContext?: IssueContext): string {
  const lines: (string | false)[] = [
    `# ${request.title}`,
    '',
    `**Repo:** ${request.repo}`,
    `**Trigger:** ${request.trigger.type}${request.trigger.type === 'webhook' ? ` (${request.trigger.event})` : ''}`,
    `**Created:** ${taskJson.created}`,
    !!request.issue && `**Issue:** ${request.issue}`,
    !!taskJson.branch && `**Branch:** ${taskJson.branch}`,
    '',
  ];

  // Issue reference section when enriched
  if (issueContext) {
    lines.push('## Issue Reference', '', `**Source:** ${issueContext.issueType} #${issueContext.issueNumber}`);
    if (issueContext.labels.length > 0) {
      lines.push(`**Labels:** ${issueContext.labels.join(', ')}`);
    }
    lines.push('');
  }

  lines.push(
    '## Description',
    '',
    request.description,
    '',
    '## Acceptance Criteria',
    '',
    '- [ ] Fix verified by tests',
    '- [ ] No regressions introduced',
    '',
  );

  // Done contract sections (skip for ideation tasks — contract subsumes this)
  if (request.issueType !== 'ideation') {
    if (request.verificationScenarios) {
      lines.push('## Verification Scenarios', '', request.verificationScenarios, '');
    }
    if (request.nonGoals) {
      lines.push('## Non-Goals', '', request.nonGoals, '');
    }
    if (request.edgeCases) {
      lines.push('## Edge Cases', '', request.edgeCases, '');
    }
    if (request.evidenceExpectations) {
      lines.push('## Evidence Expectations', '', request.evidenceExpectations, '');
    }
  }

  // Progress Log always at the end
  lines.push('## Progress Log', '', '<!-- Agents append entries below. Do not edit existing entries. -->', '');

  return lines.filter((line) => line !== false).join('\n');
}
