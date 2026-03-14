import type { ProjectEntry, TaskCreateRequest, TriggerSource } from '../../types.js';
import { runScript } from '../../util/run-script.js';
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
const seenFailures = new Map<string, number>();
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

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

  evictStaleEntries(seenFailures);

  for (const repo of repos) {
    try {
      const failures = await getRecentFailures(repo.remote);
      for (const failure of failures) {
        const key = `${repo.name}:${failure.databaseId}`;
        if (seenFailures.has(key)) continue;
        seenFailures.set(key, Date.now());

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
  const result = await runScript(
    'gh',
    [
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
    { timeout: 15_000 },
  );

  if (result.exitCode !== 0) return [];
  return JSON.parse(result.stdout) as WorkflowRun[];
}

function evictStaleEntries(map: Map<string, number>): void {
  const now = Date.now();
  for (const [key, ts] of map) {
    if (now - ts > SEEN_TTL_MS) map.delete(key);
  }
}
