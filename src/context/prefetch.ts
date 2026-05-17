import { join } from 'node:path';
import type { AgentName, PipelineConfig } from '../types.js';
import { resolveLearningsDir, resolveRepoLearnings } from '../paths.js';
import { gatherSessionContext } from '../commands/session.js';
import { runCommand } from '../util/run-command.js';
import { readPackageAsset } from '../package-assets.js';

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
  const repoLearnings = resolveRepoLearnings(config.repoPath);
  const dataDirLearnings = safeDataDirLearningsPath(config.repoName);
  const legacyLearnings = `docs/learnings/${config.repoName}.md`;

  const taskStem = config.taskJsonPath.replace(/\.task\.json$/, '');
  const workingMemoryPath = `${taskStem}.working.md`;

  const needsLearnings = role === 'implementer';
  const needsPrinciples = role === 'reviewer';
  const needsWorkingMemory = role === 'implementer';

  const promises: Promise<unknown>[] = [
    gatherSessionContext(config.repoPath, config.taskJsonPath),
    runCommand('git', ['log', '--oneline', '-10'], { cwd: config.repoPath }),
  ];

  if (needsLearnings)
    promises.push(readLearnings(repoLearnings, dataDirLearnings, legacyLearnings, config.packageRoot));
  if (needsPrinciples) promises.push(readPackageAssetSafe('docs/golden-principles.md', config.packageRoot));
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

async function readPackageAssetSafe(path: string, packageRoot: string): Promise<string> {
  try {
    return await readPackageAsset(path, { packageRoot });
  } catch {
    return '';
  }
}

function safeDataDirLearningsPath(repoName: string): string | null {
  try {
    return join(resolveLearningsDir(), `${repoName}.md`);
  } catch {
    return null;
  }
}

async function readLearnings(
  repoPath: string,
  dataDirPath: string | null,
  legacyPath: string,
  packageRoot: string,
): Promise<string> {
  const repoLocal = await readFileSafe(repoPath);
  if (repoLocal) return repoLocal;
  if (dataDirPath) {
    const dataDir = await readFileSafe(dataDirPath);
    if (dataDir) return dataDir;
  }
  return readPackageAssetSafe(legacyPath, packageRoot);
}
