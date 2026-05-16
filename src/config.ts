import { resolve } from 'node:path';
import type { PipelineConfig, PipelineMode, ProjectEntry } from './types.js';
import { resolveDataDir, resolvePackageRoot } from './paths.js';

interface ProjectsManifest {
  repos: ProjectEntry[];
}

/** Load and parse projects.json from the case root. */
export function loadProjects(caseRoot: string): Promise<ProjectEntry[]> {
  return Bun.file(resolve(caseRoot, 'projects.json'))
    .text()
    .then((raw) => (JSON.parse(raw) as ProjectsManifest).repos);
}

/** Resolve a repo path (potentially relative) to absolute from caseRoot. */
export function resolveRepoPath(caseRoot: string, repoPath: string): string {
  if (repoPath.startsWith('/')) return repoPath;
  return resolve(caseRoot, repoPath);
}

/** Build a complete PipelineConfig from a task file path and options. */
export async function buildPipelineConfig(opts: {
  taskJsonPath: string;
  mode?: PipelineMode;
  dryRun?: boolean;
  approve?: boolean;
}): Promise<PipelineConfig> {
  const taskJsonPath = resolve(opts.taskJsonPath);
  const raw = await Bun.file(taskJsonPath).text();
  const task = JSON.parse(raw) as { repo: string; mode?: PipelineMode };

  const packageRoot = resolvePackageRoot();
  // In Phase 1, dataDir defaults to packageRoot so the existing on-disk layout is unchanged.
  // CASE_DATA_DIR / XDG_CONFIG_HOME overrides honored via resolveDataDir().
  const dataDir = process.env.CASE_DATA_DIR || process.env.XDG_CONFIG_HOME ? resolveDataDir() : packageRoot;

  const projects = await loadProjects(packageRoot);
  const project = projects.find((p) => p.name === task.repo);
  if (!project) {
    throw new Error(`Repo "${task.repo}" not found in projects.json`);
  }

  const repoPath = resolveRepoPath(packageRoot, project.path);

  // Task .md path is same stem as .task.json but with .md extension
  const taskMdPath = taskJsonPath.replace(/\.task\.json$/, '.md');

  // Mode priority: CLI flag > task JSON field > default
  const mode = opts.mode ?? task.mode ?? 'attended';

  return {
    mode,
    taskJsonPath,
    taskMdPath,
    repoPath,
    repoName: task.repo,
    packageRoot,
    dataDir,
    maxRetries: 1,
    dryRun: opts.dryRun ?? false,
    approve: opts.approve ?? false,
  };
}
