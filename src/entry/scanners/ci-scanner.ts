import type { ProjectEntry, TaskCreateRequest, TriggerSource } from '../../types.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger();

interface WorkflowRun {
  databaseId: number;
  workflowName: string;
  conclusion: string;
  headBranch: string;
  url: string;
  headSha: string;
}

/** Track which failures we've already created tasks for (prevents duplicates). */
const seenFailures = new Set<string>();

/**
 * Scan GitHub Actions for CI failures on main across all repos.
 * Uses `gh` CLI — no API token management needed.
 */
export async function scanCIFailures(repos: ProjectEntry[]): Promise<TaskCreateRequest[]> {
  const tasks: TaskCreateRequest[] = [];
  const trigger: TriggerSource = {
    type: 'scanner',
    scanner: 'ci',
    runId: `ci-${Date.now().toString(36)}`,
  };

  for (const repo of repos) {
    try {
      const failures = await getRecentFailures(repo.remote);
      for (const failure of failures) {
        const key = `${repo.name}:${failure.databaseId}`;
        if (seenFailures.has(key)) continue;
        seenFailures.add(key);

        tasks.push({
          repo: repo.name,
          title: `Fix CI failure: ${failure.workflowName}`,
          description: [
            `CI workflow "${failure.workflowName}" failed on ${failure.headBranch}.`,
            '',
            `- **SHA:** ${failure.headSha}`,
            `- **Run URL:** ${failure.url}`,
            '',
            'Investigate the failure, identify the root cause, and fix it.',
          ].join('\n'),
          issueType: 'freeform',
          issue: failure.url,
          mode: 'unattended',
          trigger,
          autoStart: false,
        });
      }
    } catch (err) {
      log.error('ci scanner failed for repo', { repo: repo.name, error: String(err) });
    }
  }

  if (tasks.length > 0) {
    log.info('ci scanner found failures', { count: tasks.length });
  }

  return tasks;
}

async function getRecentFailures(remote: string): Promise<WorkflowRun[]> {
  const match = remote.match(/github\.com[:/](.+?)\.git$/);
  if (!match) return [];

  const ghRepo = match[1];

  const proc = Bun.spawn(
    [
      'gh',
      'run',
      'list',
      '--repo',
      ghRepo,
      '--branch',
      'main',
      '--status',
      'failure',
      '--limit',
      '5',
      '--json',
      'databaseId,workflowName,conclusion,headBranch,url,headSha',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const timer = setTimeout(() => proc.kill(), 15_000);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);

  return JSON.parse(stdout) as WorkflowRun[];
}
