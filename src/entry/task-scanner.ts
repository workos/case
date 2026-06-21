import { determineEntryPhase } from '../state/transitions.js';
import { loadProjectsManifest, resolveRepoPath } from '../config.js';
import { decodeState, tdCurrent, tdList, tdShow } from '../state/td-client.js';
import type { PipelinePhase, TaskJson } from '../types.js';

export interface TaskMatch {
  taskJson: TaskJson;
  /** td issue handle backing the matched task. */
  tdId: string;
  entryPhase: PipelinePhase;
}

/**
 * Find an active task for the given issue by querying the repo's `td` store.
 *
 * Tasks are tagged with `repo:<name>` and `issue:<n>` labels at creation, so a
 * label-filtered `td list` narrows the candidates; the embedded case-state then
 * confirms the issue type. Returns the match with its resolved entry phase, or
 * null when no live task tracks the issue.
 */
export async function findTaskByIssue(
  caseRoot: string,
  repoName: string,
  issueType: 'github' | 'linear' | 'freeform',
  issueNumber: string,
  repoPath?: string,
): Promise<TaskMatch | null> {
  const resolvedRepoPath = repoPath ?? (await resolveTargetRepoPath(caseRoot, repoName));

  const candidates = await tdList(resolvedRepoPath, [`repo:${repoName}`, `issue:${issueNumber}`]);
  for (const issue of candidates) {
    const task = decodeState(issue.description);
    if (!task) continue;
    if (task.repo === repoName && task.issueType === issueType && task.issue === issueNumber) {
      return toMatch(task, issue.id);
    }
  }
  return null;
}

/**
 * Resolve the repo's currently focused task (the `td` replacement for the old
 * `.case/active` marker). Returns null when nothing is focused or the focused
 * issue has no case-state payload.
 */
export async function findTaskByMarker(caseRoot: string, repoPath: string): Promise<TaskMatch | null> {
  void caseRoot;
  const tdId = await tdCurrent(repoPath);
  if (!tdId) return null;

  const issue = await tdShow(repoPath, tdId);
  if (!issue) return null;

  const task = decodeState(issue.description);
  if (!task) return null;

  return toMatch(task, issue.id);
}

function toMatch(task: TaskJson, tdId: string): TaskMatch {
  return { taskJson: { ...task, tdId }, tdId, entryPhase: determineEntryPhase(task) };
}

async function resolveTargetRepoPath(caseRoot: string, repoName: string): Promise<string> {
  const manifest = await loadProjectsManifest(caseRoot);
  const project = manifest.repos.find((p) => p.name === repoName);
  if (!project) throw new Error(`Repo "${repoName}" not found in projects.json`);
  return resolveRepoPath(manifest.repoBasePath, project.path);
}
