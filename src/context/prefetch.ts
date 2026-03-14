import { resolve } from 'node:path';
import type { AgentName, PipelineConfig } from '../types.js';
import { runScript } from '../util/run-script.js';

export interface RepoContext {
  sessionJson: Record<string, unknown>;
  learnings: string;
  recentCommits: string;
  goldenPrinciples: string;
  workingMemory: string | null;
}

/**
 * Gather repo context deterministically. Runs session-start.sh and reads
 * learnings in parallel for speed. Only fetches what the role needs.
 */
export async function prefetchRepoContext(config: PipelineConfig, role: AgentName): Promise<RepoContext> {
  const sessionStartScript = resolve(config.caseRoot, 'scripts/session-start.sh');
  const learningsPath = resolve(config.caseRoot, `docs/learnings/${config.repoName}.md`);
  const principlesPath = resolve(config.caseRoot, 'docs/golden-principles.md');

  // Derive working memory path from task file
  const taskStem = config.taskJsonPath.replace(/\.task\.json$/, '');
  const workingMemoryPath = `${taskStem}.working.md`;

  // Parallel fetching — only what the role needs
  const promises: Promise<unknown>[] = [
    // All roles get session context
    runScript('bash', [sessionStartScript, config.repoPath, '--task', config.taskJsonPath]),
    // All roles get recent commits
    runScript('git', ['log', '--oneline', '-10'], { cwd: config.repoPath }),
  ];

  // Implementer gets learnings + working memory
  // Reviewer reads golden principles itself, but we prefetch for efficiency
  const needsLearnings = role === 'implementer';
  const needsPrinciples = role === 'reviewer';
  const needsWorkingMemory = role === 'implementer';

  if (needsLearnings) {
    promises.push(readFileSafe(learningsPath));
  }
  if (needsPrinciples) {
    promises.push(readFileSafe(principlesPath));
  }
  if (needsWorkingMemory) {
    promises.push(readFileSafe(workingMemoryPath));
  }

  const results = await Promise.all(promises);

  const sessionResult = results[0] as { stdout: string };
  const commitsResult = results[1] as { stdout: string };

  let sessionJson: Record<string, unknown> = {};
  try {
    sessionJson = JSON.parse(sessionResult.stdout) as Record<string, unknown>;
  } catch {
    // Non-fatal — session script output wasn't valid JSON
  }

  let idx = 2;
  const learnings = needsLearnings ? (results[idx++] as string) : '';
  const goldenPrinciples = needsPrinciples ? (results[idx++] as string) : '';
  const workingMemory = needsWorkingMemory ? (results[idx++] as string) || null : null;

  return {
    sessionJson,
    learnings,
    recentCommits: commitsResult.stdout.trim(),
    goldenPrinciples,
    workingMemory,
  };
}

async function readFileSafe(path: string): Promise<string> {
  const file = Bun.file(path);
  if (await file.exists()) {
    return file.text();
  }
  return '';
}
