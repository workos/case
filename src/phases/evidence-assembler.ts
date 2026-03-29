import { resolve } from 'node:path';
import type {
  AgentName,
  AgentResult,
  ApprovalEvidence,
  PipelineConfig,
  RubricCategory,
} from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { runScript } from '../util/run-script.js';

/**
 * Collect all evidence from pipeline results + git diff into a single
 * ApprovalEvidence payload for the approval gate UI to render.
 */
export async function assembleEvidence(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
): Promise<ApprovalEvidence> {
  const task = await store.read();

  // --- Git diff ---
  const [statResult, diffResult] = await Promise.all([
    runScript('git', ['diff', 'main...HEAD', '--stat'], { cwd: config.repoPath }),
    runScript('git', ['diff', 'main...HEAD'], { cwd: config.repoPath }),
  ]);

  const diffSummary = parseDiffStat(statResult.exitCode === 0 ? statResult.stdout : '');
  const diffFiles = parseDiff(diffResult.exitCode === 0 ? diffResult.stdout : '');

  // --- Agent results ---
  const implResult = previousResults.get('implementer');
  const verifierResult = previousResults.get('verifier');
  const reviewerResult = previousResults.get('reviewer');

  // --- Screenshots from all results ---
  const screenshots: string[] = [];
  for (const result of previousResults.values()) {
    for (const url of result.artifacts.screenshotUrls) {
      const abs = url.startsWith('file://') ? url.slice(7) : url;
      screenshots.push(resolve(abs));
    }
  }

  return {
    task: {
      id: task.id,
      title: task.issue ?? task.id,
      repo: config.repoName,
      branch: task.branch ?? 'unknown',
      issue: task.issue,
    },
    diff: {
      summary: diffSummary,
      files: diffFiles,
    },
    tests: {
      passed: implResult?.artifacts.testsPassed ?? null,
      summary: implResult?.artifacts.testsPassed === true
        ? 'All tests passed'
        : implResult?.artifacts.testsPassed === false
          ? 'Tests failed'
          : null,
    },
    verifier: {
      ran: !!verifierResult,
      rubric: verifierResult?.rubric?.categories ?? null,
      summary: verifierResult?.summary ?? null,
    },
    reviewer: {
      ran: !!reviewerResult,
      rubric: reviewerResult?.rubric?.categories ?? null,
      findings: reviewerResult?.findings ?? null,
      summary: reviewerResult?.summary ?? null,
    },
    screenshots,
    commit: implResult?.artifacts.commit ?? null,
  };
}

// --- Diff parsing ---

interface DiffSummary {
  additions: number;
  deletions: number;
  filesChanged: number;
}

function parseDiffStat(statOutput: string): DiffSummary {
  const summary: DiffSummary = { additions: 0, deletions: 0, filesChanged: 0 };
  if (!statOutput.trim()) return summary;

  // Last line of `git diff --stat` looks like:
  //  3 files changed, 42 insertions(+), 5 deletions(-)
  const lines = statOutput.trim().split('\n');
  const lastLine = lines[lines.length - 1];

  const filesMatch = lastLine.match(/(\d+) files? changed/);
  const addMatch = lastLine.match(/(\d+) insertions?\(\+\)/);
  const delMatch = lastLine.match(/(\d+) deletions?\(-\)/);

  if (filesMatch) summary.filesChanged = parseInt(filesMatch[1], 10);
  if (addMatch) summary.additions = parseInt(addMatch[1], 10);
  if (delMatch) summary.deletions = parseInt(delMatch[1], 10);

  return summary;
}

type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: FileStatus;
  hunks: Array<{ header: string; lines: string[] }>;
}

export function parseDiff(rawDiff: string): DiffFile[] {
  if (!rawDiff.trim()) return [];

  const files: DiffFile[] = [];
  // Split on "diff --git" boundaries
  const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split('\n');
    // First line: a/path b/path
    const headerLine = lines[0];
    const pathMatch = headerLine.match(/b\/(.+)$/);
    if (!pathMatch) continue;

    const path = pathMatch[1];
    let status: FileStatus = 'modified';

    if (section.includes('new file mode')) status = 'added';
    else if (section.includes('deleted file mode')) status = 'deleted';
    else if (section.includes('rename from')) status = 'renamed';

    // Handle binary files
    if (section.includes('Binary files')) {
      files.push({ path, additions: 0, deletions: 0, status, hunks: [] });
      continue;
    }

    // Parse hunks
    const hunks: Array<{ header: string; lines: string[] }> = [];
    let currentHunk: { header: string; lines: string[] } | null = null;
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (currentHunk) hunks.push(currentHunk);
        currentHunk = { header: line, lines: [] };
      } else if (currentHunk) {
        currentHunk.lines.push(line);
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      }
    }
    if (currentHunk) hunks.push(currentHunk);

    files.push({ path, additions, deletions, status, hunks });
  }

  return files;
}
