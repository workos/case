/**
 * Canonical path resolver.
 *
 * Single source of truth for resolving:
 *   - packageRoot: disk checkout for static asset overrides, or embedded://case
 *   - dataDir:     user-level config/cache state
 *   - repo .case/: mutable task runtime state
 *
 * Task runtime state lives under each target repo's ignored `.case/`
 * directory. The user data dir remains for config, projects.json, and prompt
 * version metadata.
 *
 * Pure functions — no module-level cache. Callers cache the result in PipelineConfig
 * so env changes between calls (especially in tests) take effect.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const EMBEDDED_PACKAGE_ROOT = 'embedded://case';

/**
 * Resolve the case package root by walking up from likely runtime anchors
 * until a package.json with `name === "case"` is found.
 *
 * Falls back to an embedded pseudo-root when running from a self-contained
 * binary with package assets bundled into the executable.
 */
export function resolvePackageRoot(): string {
  return tryResolvePackageRoot() ?? EMBEDDED_PACKAGE_ROOT;
}

/** Resolve the on-disk case package root, if one is available. */
export function tryResolvePackageRoot(): string | null {
  const starts = packageRootStarts();
  for (const start of starts) {
    const found = findPackageRootFrom(start);
    if (found) return found;
  }

  return null;
}

export function isEmbeddedPackageRoot(packageRoot: string): boolean {
  return packageRoot === EMBEDDED_PACKAGE_ROOT || packageRoot.startsWith('embedded://');
}

function packageRootStarts(): string[] {
  const starts = [
    process.env.CASE_PACKAGE_ROOT,
    import.meta.dir,
    process.cwd(),
    dirname(process.execPath),
    dirname(dirname(process.execPath)),
  ].filter((start): start is string => Boolean(start));

  return [...new Set(starts.map((start) => resolve(start)))];
}

function findPackageRootFrom(start: string): string | null {
  let current = start;

  while (true) {
    const manifestPath = resolve(current, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name?: string };
        if (manifest.name === 'case') {
          return current;
        }
      } catch {
        // Malformed package.json — keep walking.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Resolve the case user config/cache directory using XDG precedence.
 *
 * Precedence:
 *   1. process.env.CASE_DATA_DIR
 *   2. ${process.env.XDG_CONFIG_HOME}/case
 *   3. ${process.env.HOME}/.config/case
 *
 * This is intentionally separate from repo-local runtime state. Tasks, event logs,
 * markers, amendments, and repo learnings live under each target repo's ignored
 * `.case/` directory.
 *
 * @throws if HOME is unset and no CASE_DATA_DIR or XDG_CONFIG_HOME override is provided.
 */
export function resolveDataDir(): string {
  if (process.env.CASE_DATA_DIR) {
    return resolve(process.env.CASE_DATA_DIR);
  }
  if (process.env.XDG_CONFIG_HOME) {
    return resolve(process.env.XDG_CONFIG_HOME, 'case');
  }
  if (process.env.HOME) {
    return resolve(process.env.HOME, '.config', 'case');
  }
  throw new Error('CASE_DATA_DIR, XDG_CONFIG_HOME, or HOME must be set');
}

/** Resolve the path to an agent prompt template under packageRoot/agents when a disk package root exists. */
export function resolveAgent(role: string): string {
  return resolve(resolvePackageRoot(), 'agents', `${role}.md`);
}

/** Resolve a doc path under packageRoot/docs when a disk package root exists. */
export function resolveDoc(relativePath: string): string {
  return resolve(resolvePackageRoot(), 'docs', relativePath);
}

/** Legacy: resolve a task JSON path under dataDir/tasks/active. New tasks are repo-local. */
export function resolveTask(slug: string): string {
  return resolve(resolveDataDir(), 'tasks', 'active', `${slug}.task.json`);
}

/** Legacy: resolve the tasks/ directory under dataDir. New tasks are repo-local. */
export function resolveTaskDir(): string {
  return resolve(resolveDataDir(), 'tasks');
}

/** Resolve the ignored Case state directory inside a target repo. */
export function resolveRepoCaseDir(repoPath: string): string {
  return resolve(repoPath, '.case');
}

/** Resolve the active task marker in a target repo. */
export function resolveRepoActiveMarker(repoPath: string): string {
  return resolve(resolveRepoCaseDir(repoPath), 'active');
}

/** Resolve the repo-local active task directory. */
export function resolveRepoActiveTaskDir(repoPath: string): string {
  return resolve(resolveRepoCaseDir(repoPath), 'tasks', 'active');
}

/** Resolve a repo-local task JSON path. */
export function resolveRepoTaskJson(repoPath: string, slug: string): string {
  return resolve(resolveRepoActiveTaskDir(repoPath), `${slug}.task.json`);
}

/** Resolve tactical repo learnings for a target repo. */
export function resolveRepoLearnings(repoPath: string): string {
  return resolve(resolveRepoCaseDir(repoPath), 'learnings.md');
}

/** Resolve repo-local amendment proposals. */
export function resolveRepoAmendmentsDir(repoPath: string): string {
  return resolve(resolveRepoCaseDir(repoPath), 'amendments');
}

/** Resolve repo-local run metrics. */
export function resolveRepoRunLog(repoPath: string): string {
  return resolve(resolveRepoCaseDir(repoPath), 'run-log.jsonl');
}

/** Legacy: resolve the learnings/ directory under dataDir. New learnings are repo-local. */
export function resolveLearningsDir(): string {
  return resolve(resolveDataDir(), 'learnings');
}

/** Legacy: resolve the amendments/ directory under dataDir. New amendments are repo-local. */
export function resolveAmendmentsDir(): string {
  return resolve(resolveDataDir(), 'amendments');
}

/** Legacy: resolve the append-only run-log.jsonl path under dataDir. New run logs are repo-local. */
export function resolveRunLogPath(): string {
  return resolve(resolveDataDir(), 'run-log.jsonl');
}

/** Resolve the agent-versions/ directory under dataDir. */
export function resolveAgentVersionsDir(): string {
  return resolve(resolveDataDir(), 'agent-versions');
}

/** Resolve the config.json path under dataDir. */
export function resolveConfigPath(): string {
  return resolve(resolveDataDir(), 'config.json');
}
