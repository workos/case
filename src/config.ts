import { isAbsolute, resolve } from 'node:path';
import type { PipelineConfig, PipelineMode, ProjectEntry } from './types.js';
import { resolveDataDir, resolvePackageRoot } from './paths.js';
import { configExists, readConfig } from './data-dir.js';

interface ProjectsManifest {
  repos: ProjectEntry[];
}

/**
 * Load and parse projects.json.
 *
 * Phase 3 resolution order:
 *   1. `<dataDir>/<readConfig().projects>` (path may be absolute or relative to dataDir)
 *   2. `<caseRoot>/projects.json` — legacy in-repo path, retained for back-compat
 *
 * Logs a deprecation notice when (2) is used.
 */
export async function loadProjects(caseRoot: string): Promise<ProjectEntry[]> {
  const candidates = projectsManifestCandidates(caseRoot);
  for (let i = 0; i < candidates.length; i++) {
    const path = candidates[i]!;
    const file = Bun.file(path);
    if (await file.exists()) {
      if (i > 0) {
        process.stderr.write(
          `case: deprecation — projects.json read from legacy path ${path}; move it to ${candidates[0]} (or run 'ca init --migrate-from <repo>').\n`,
        );
      }
      const raw = await file.text();
      return (JSON.parse(raw) as ProjectsManifest).repos;
    }
  }
  throw new Error(
    `projects.json not found. Looked in:\n  ${candidates.join('\n  ')}\nRun 'ca init' or set --projects.`,
  );
}

/** Candidate paths for projects.json in resolution order. */
function projectsManifestCandidates(caseRoot: string): string[] {
  const list: string[] = [];
  try {
    // Only add the XDG data dir candidate when the user has explicitly opted
    // into Phase 3 by running `ca init` (which creates config.json).
    // Without this guard, every invocation falls back to the legacy in-repo
    // path and prints a spurious deprecation warning.
    if (configExists()) {
      const cfg = readConfig();
      const configured = cfg.projects;
      if (configured) {
        list.push(isAbsolute(configured) ? configured : resolve(resolveDataDir(), configured));
      } else {
        list.push(resolve(resolveDataDir(), 'projects.json'));
      }
    }
  } catch {
    // resolveDataDir() can throw if HOME/XDG/CASE_DATA_DIR are all unset.
    // Fall through to caseRoot.
  }
  list.push(resolve(caseRoot, 'projects.json'));
  return list;
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
