import { mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import type { TaskCreateRequest, TaskJson } from '../types.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/** Slugify a title for use in file names. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

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

/**
 * Create a task.json + task.md pair in tasks/active/ from a TaskCreateRequest.
 * Returns paths to the created files for pipeline dispatch.
 */
export async function createTask(caseRoot: string, request: TaskCreateRequest): Promise<TaskCreateResult> {
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
    mode: request.mode ?? 'attended',
    agents: {},
    tested: false,
    manualTested: false,
    prUrl: null,
    prNumber: null,
    checkCommand: request.checkCommand ?? null,
    checkBaseline: request.checkBaseline ?? null,
    checkTarget: request.checkTarget ?? null,
  };

  const taskMd = [
    `# ${request.title}`,
    '',
    `**Repo:** ${request.repo}`,
    `**Trigger:** ${request.trigger.type}${request.trigger.type === 'webhook' ? ` (${request.trigger.event})` : ''}`,
    `**Created:** ${taskJson.created}`,
    request.issue ? `**Issue:** ${request.issue}` : '',
    '',
    '## Description',
    '',
    request.description,
    '',
    '## Acceptance Criteria',
    '',
    '- [ ] Fix verified by tests',
    '- [ ] No regressions introduced',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  await Bun.write(taskJsonPath, JSON.stringify(taskJson, null, 2) + '\n');
  await Bun.write(taskMdPath, taskMd);

  log.info('task created', {
    taskId,
    repo: request.repo,
    trigger: request.trigger.type,
    file: basename(taskJsonPath),
  });

  return { taskId, taskJsonPath, taskMdPath };
}
