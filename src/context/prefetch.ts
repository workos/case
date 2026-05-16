import { join, resolve } from 'node:path';
import type { AgentName, PipelineConfig } from '../types.js';
import { resolveLearningsDir } from '../paths.js';
import { gatherSessionContext } from '../commands/session.js';
import { runScript } from '../util/run-script.js';

export interface RepoContext {
  sessionJson: Record<string, unknown>;
  learnings: string;
  recentCommits: string;
  goldenPrinciples: string;
  workingMemory: string | null;
}

/**
 * Gather repo context deterministically. Calls gatherSessionContext()
 * and reads learnings in parallel for speed. Only fetches what the role needs.
 */
export async function prefetchRepoContext(config: PipelineConfig, role: AgentName): Promise<RepoContext> {
  const dataDirLearnings = join(resolveLearningsDir(), `${config.repoName}.md`);
  const legacyLearnings = resolve(config.packageRoot, `docs/learnings/${config.repoName}.md`);
  const principlesPath = resolve(config.packageRoot, 'docs/golden-principles.md');

  const taskStem = config.taskJsonPath.replace(/\.task\.json$/, '');
  const workingMemoryPath = `${taskStem}.working.md`;

  const needsLearnings = role === 'implementer';
  const needsPrinciples = role === 'reviewer';
  const needsWorkingMemory = role === 'implementer';

  const promises: Promise<unknown>[] = [
    gatherSessionContext(config.repoPath, config.taskJsonPath),
    runScript('git', ['log', '--oneline', '-10'], { cwd: config.repoPath }),
  ];

  if (needsLearnings) promises.push(readLearnings(dataDirLearnings, legacyLearnings));
  if (needsPrinciples) promises.push(readFileSafe(principlesPath));
  if (needsWorkingMemory) promises.push(readFileSafe(workingMemoryPath));

  const results = await Promise.all(promises);

  const sessionJson = results[0] as Record<string, unknown>;
  const commitsResult = results[1] as { stdout: string };

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
  if (await file.exists()) return file.text();
  return '';
}

async function readLearnings(dataDirPath: string, legacyPath: string): Promise<string> {
  const dataDir = await readFileSafe(dataDirPath);
  if (dataDir) return dataDir;
  return readFileSafe(legacyPath);
}
