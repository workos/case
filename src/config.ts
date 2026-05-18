import { dirname, isAbsolute, resolve } from 'node:path';
import type { PipelineConfig, PipelineMode, ProjectEntry } from './types.js';
import { isEmbeddedPackageRoot, resolveDataDir, resolvePackageRoot } from './paths.js';
import { configExists, readConfig } from './data-dir.js';

interface ProjectsManifest {
  repos: ProjectEntry[];
}

export interface LoadedProjectsManifest {
  repos: ProjectEntry[];
  path: string;
  /** Base path used to resolve relative repo paths in this manifest. */
  repoBasePath: string;
}

interface ProjectsManifestCandidate {
  path: string;
  repoBasePath: string;
}

/**
 * Load and parse projects.json.
 *
 * Config resolution order:
 *   1. `<dataDir>/<readConfig().projects>` (path may be absolute or relative to dataDir)
 *   2. `<caseRoot>/projects.json` — legacy in-repo path, retained for back-compat
 *
 * Logs a deprecation notice when (2) is used.
 */
export async function loadProjects(caseRoot: string): Promise<ProjectEntry[]> {
  return (await loadProjectsManifest(caseRoot)).repos;
}

let deprecationWarned = false;

export async function loadProjectsManifest(caseRoot: string): Promise<LoadedProjectsManifest> {
  const candidates = projectsManifestCandidates(caseRoot);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const file = Bun.file(candidate.path);
    if (await file.exists()) {
      if (i > 0 && !deprecationWarned && process.env.CASE_QUIET !== '1') {
        deprecationWarned = true;
        process.stderr.write(
          `case: deprecation — projects.json read from legacy path ${candidate.path}; move it to ${candidates[0]?.path} (or run 'ca init --migrate-from <repo>').\n`,
        );
      }
      const raw = await file.text();
      return {
        repos: (JSON.parse(raw) as ProjectsManifest).repos,
        path: candidate.path,
        repoBasePath: candidate.repoBasePath,
      };
    }
  }
  const looked =
    candidates.length > 0
      ? candidates.map((candidate) => candidate.path).join('\n  ')
      : '(no configured projects path)';
  throw new Error(`projects.json not found. Looked in:\n  ${looked}\nRun 'ca init' or set --projects.`);
}

/** Candidate paths for projects.json in resolution order. */
function projectsManifestCandidates(caseRoot: string): ProjectsManifestCandidate[] {
  const list: ProjectsManifestCandidate[] = [];
  try {
    // Only add the user config dir candidate when the user has explicitly
    // initialized Case by running `ca init` (which creates config.json).
    // Without this guard, every invocation falls back to the legacy in-repo
    // path and prints a spurious deprecation warning.
    if (configExists()) {
      const cfg = readConfig();
      const configured = cfg.projects;
      if (configured) {
        const path = isAbsolute(configured) ? configured : resolve(resolveDataDir(), configured);
        list.push({ path, repoBasePath: isEmbeddedPackageRoot(caseRoot) ? dirname(path) : caseRoot });
      } else {
        const path = resolve(resolveDataDir(), 'projects.json');
        list.push({ path, repoBasePath: isEmbeddedPackageRoot(caseRoot) ? dirname(path) : caseRoot });
      }
    }
  } catch {
    // resolveDataDir() can throw if HOME/XDG/CASE_DATA_DIR are all unset.
    // Fall through to caseRoot.
  }
  if (!isEmbeddedPackageRoot(caseRoot)) {
    list.push({ path: resolve(caseRoot, 'projects.json'), repoBasePath: caseRoot });
  }
  return list;
}

/** Resolve a repo path (potentially relative) to absolute from caseRoot. */
export function resolveRepoPath(basePath: string, repoPath: string): string {
  if (repoPath.startsWith('/')) return repoPath;
  return resolve(basePath, repoPath);
}

/** Build a complete PipelineConfig from a task file path and options. */
export async function buildPipelineConfig(opts: {
  taskJsonPath: string;
  mode?: PipelineMode;
  dryRun?: boolean;
}): Promise<PipelineConfig> {
  const taskJsonPath = resolve(opts.taskJsonPath);
  const raw = await Bun.file(taskJsonPath).text();
  const task = JSON.parse(raw) as { repo: string; mode?: PipelineMode };

  const packageRoot = resolvePackageRoot();

  const manifest = await loadProjectsManifest(packageRoot);
  const project = manifest.repos.find((p) => p.name === task.repo);
  if (!project) {
    throw new Error(`Repo "${task.repo}" not found in projects.json`);
  }

  const repoPath = resolveRepoPath(manifest.repoBasePath, project.path);
  // Mutable task runtime state is repo-local under `<repo>/.case/`.
  // The field is still named dataDir for API compatibility with the existing pipeline code.
  const dataDir = repoPath;

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
    project,
    packageRoot,
    dataDir,
    maxRetries: 1,
    dryRun: opts.dryRun ?? false,
  };
}
