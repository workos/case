import { join, resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { determineEntryPhase } from '../state/transitions.js';
import { resolveRepoActiveMarker, resolveRepoActiveTaskDir, resolveRepoTaskJson, resolveTaskDir } from '../paths.js';
import type { TaskJson, PipelinePhase } from '../types.js';

const STALE_MARKER_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface TaskMatch {
  taskJson: TaskJson;
  taskJsonPath: string;
  taskMdPath: string;
  entryPhase: PipelinePhase;
}

/**
 * Scan active task JSON files for a task matching the given issue.
 * Returns the match with its resolved entry phase, or null if not found.
 *
 * Scans repo-local `.case/tasks/active` first, then legacy global/in-repo locations.
 */
export async function findTaskByIssue(
  caseRoot: string,
  repoName: string,
  issueType: 'github' | 'linear' | 'freeform',
  issueNumber: string,
  repoPath?: string,
): Promise<TaskMatch | null> {
  for (const activeDir of activeDirCandidates(caseRoot, repoPath)) {
    let entries: string[];
    try {
      entries = await readdir(activeDir);
    } catch {
      continue;
    }

    for (const file of entries.filter((f) => f.endsWith('.task.json'))) {
      const taskJsonPath = resolve(activeDir, file);
      try {
        const raw = await Bun.file(taskJsonPath).text();
        const task = JSON.parse(raw) as TaskJson;

        if (task.repo === repoName && task.issueType === issueType && task.issue === issueNumber) {
          const entryPhase = determineEntryPhase(task);
          const taskMdPath = taskJsonPath.replace(/\.task\.json$/, '.md');
          return { taskJson: task, taskJsonPath, taskMdPath, entryPhase };
        }
      } catch {
        // Skip unparseable files
        continue;
      }
    }
  }

  return null;
}

/** Candidate active-tasks dirs in resolution order. */
function activeDirCandidates(caseRoot: string, repoPath?: string): string[] {
  const list: string[] = [];
  if (repoPath) {
    list.push(resolveRepoActiveTaskDir(repoPath));
  }
  try {
    list.push(join(resolveTaskDir(), 'active'));
  } catch {
    // resolveDataDir() may throw if HOME/XDG/CASE_DATA_DIR unset
  }
  list.push(resolve(caseRoot, 'tasks/active'));
  return list;
}

/**
 * Scan for a task via the `.case/active` marker in the given repo directory.
 * Reads the task ID from the marker file, then loads the task JSON directly.
 *
 * Handles stale markers (>24h) and missing task files by cleaning up.
 */
export async function findTaskByMarker(caseRoot: string, repoPath: string): Promise<TaskMatch | null> {
  const markerPath = resolveRepoActiveMarker(repoPath);

  // Check marker exists and staleness in one stat call
  let markerStat;
  try {
    markerStat = await stat(markerPath);
  } catch {
    return null; // Marker doesn't exist
  }

  const ageMs = Date.now() - markerStat.mtimeMs;
  if (ageMs > STALE_MARKER_MS) {
    await cleanupActiveMarker(markerPath);
    process.stdout.write('Stale .case/active marker (>24h) cleaned up.\n');
    return null;
  }

  // Read task ID from marker
  const taskId = (await Bun.file(markerPath).text()).trim();
  if (!taskId) {
    await cleanupActiveMarker(markerPath);
    return null;
  }

  // Load the task JSON — try repo-local state first, then legacy dataDir/in-repo paths.
  let taskJsonPath: string | null = null;
  for (const candidate of [
    resolveRepoTaskJson(repoPath, taskId),
    ...activeDirCandidates(caseRoot).map((activeDir) => resolve(activeDir, `${taskId}.task.json`)),
  ]) {
    if (await Bun.file(candidate).exists()) {
      taskJsonPath = candidate;
      break;
    }
  }

  if (!taskJsonPath) {
    await cleanupActiveMarker(markerPath);
    process.stdout.write('Stale marker cleaned. No active task.\n');
    return null;
  }

  try {
    const raw = await Bun.file(taskJsonPath).text();
    const task = JSON.parse(raw) as TaskJson;
    const entryPhase = determineEntryPhase(task);
    const taskMdPath = taskJsonPath.replace(/\.task\.json$/, '.md');

    return { taskJson: task, taskJsonPath, taskMdPath, entryPhase };
  } catch {
    await cleanupActiveMarker(markerPath);
    return null;
  }
}

/** Remove only the active marker; repo-local learnings and task history are kept. */
async function cleanupActiveMarker(markerPath: string): Promise<void> {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(markerPath, { force: true });
  } catch {
    // Already removed or inaccessible
  }
}
