import { resolve } from 'node:path';
import type { ProjectEntry, TaskCreateRequest, TriggerSource } from '../../types.js';
import { runScript } from '../../util/run-script.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger();

/** Track repos we've already flagged outdated deps for (with TTL). */
const flaggedRepos = new Map<string, number>();
const FLAGGED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface OutdatedPackage {
  name: string;
  current: string;
  latest: string;
  type: string;
}

/**
 * Check for outdated dependencies across repos.
 * Uses pnpm outdated (all repos are pnpm-based).
 */
export async function scanOutdatedDeps(caseRoot: string, repos: ProjectEntry[]): Promise<TaskCreateRequest[]> {
  const tasks: TaskCreateRequest[] = [];
  const trigger: TriggerSource = {
    type: 'scanner',
    scanner: 'deps',
    runId: `deps-${Date.now().toString(36)}`,
  };

  evictStaleEntries(flaggedRepos);

  for (const repo of repos) {
    if (flaggedRepos.has(repo.name)) continue;

    try {
      const repoPath = repo.path.startsWith('/') ? repo.path : resolve(caseRoot, repo.path);

      const outdated = await getOutdatedPackages(repoPath, repo.packageManager);
      if (outdated.length === 0) continue;

      const significant = outdated.filter((pkg) => {
        const [curMajor] = pkg.current.split('.');
        const [latMajor] = pkg.latest.split('.');
        return curMajor !== latMajor;
      });

      if (significant.length === 0) continue;

      flaggedRepos.set(repo.name, Date.now());

      const depList = significant.map((p) => `- ${p.name}: ${p.current} → ${p.latest}`).join('\n');

      tasks.push({
        repo: repo.name,
        title: `Update ${significant.length} outdated dependencies`,
        description: [
          `Major version updates available:`,
          '',
          depList,
          '',
          'Update each dependency, run tests, and verify nothing breaks.',
        ].join('\n'),
        issueType: 'freeform',
        mode: 'attended',
        trigger,
        autoStart: false,
      });
    } catch (err) {
      log.error('deps scanner failed for repo', { repo: repo.name, error: String(err) });
    }
  }

  if (tasks.length > 0) {
    log.info('deps scanner found outdated packages', { count: tasks.length });
  }

  return tasks;
}

async function getOutdatedPackages(repoPath: string, packageManager: string): Promise<OutdatedPackage[]> {
  const cmd = packageManager === 'pnpm' ? 'pnpm' : 'npm';
  // pnpm/npm outdated exits non-zero when outdated packages exist — that's expected
  const result = await runScript(cmd, ['outdated', '--json'], { cwd: repoPath, timeout: 30_000 });
  return parseOutdatedOutput(result.stdout);
}

function parseOutdatedOutput(stdout: string): OutdatedPackage[] {
  if (!stdout.trim()) return [];

  try {
    const data = JSON.parse(stdout) as Record<string, { current: string; latest: string; type: string }>;
    return Object.entries(data).map(([name, info]) => ({
      name,
      current: info.current,
      latest: info.latest,
      type: info.type,
    }));
  } catch {
    return [];
  }
}

function evictStaleEntries(map: Map<string, number>): void {
  const now = Date.now();
  for (const [key, ts] of map) {
    if (now - ts > FLAGGED_TTL_MS) map.delete(key);
  }
}
