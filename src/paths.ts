/**
 * Canonical path resolver.
 *
 * Single source of truth for resolving:
 *   - packageRoot: static assets shipped with the package (agents/, docs/)
 *   - dataDir:     mutable state (tasks/, .case/, learnings/)
 *
 * In Phase 1 both resolve to the same on-disk location by default — the package root.
 * The semantic split is in place so a future phase can move dataDir to
 * $XDG_CONFIG_HOME/case without further refactors.
 *
 * Pure functions — no module-level cache. Callers cache the result in PipelineConfig
 * so env changes between calls (especially in tests) take effect.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Resolve the case package root by walking up from likely runtime anchors
 * until a package.json with `name === "case"` is found.
 *
 * @throws if the filesystem root is reached without finding a matching package.json.
 */
export function resolvePackageRoot(): string {
  const starts = packageRootStarts();
  for (const start of starts) {
    const found = findPackageRootFrom(start);
    if (found) return found;
  }

  throw new Error(`Could not find case package.json walking up from: ${starts.join(', ')}`);
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
 * Resolve the case data directory using XDG precedence.
 *
 * Precedence:
 *   1. process.env.CASE_DATA_DIR
 *   2. ${process.env.XDG_CONFIG_HOME}/case
 *   3. ${process.env.HOME}/.config/case
 *
 * Phase 1 callers (see `buildPipelineConfig`) typically keep `dataDir === packageRoot`
 * unless `CASE_DATA_DIR` or `XDG_CONFIG_HOME` is set, so the existing on-disk layout
 * (tasks/ under the repo) is unchanged. This resolver itself does not implement that
 * fallback — it always returns an XDG-style location.
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

/** Resolve the path to an agent prompt template under packageRoot/agents. */
export function resolveAgent(role: string): string {
  return resolve(resolvePackageRoot(), 'agents', `${role}.md`);
}

/** Resolve a doc path under packageRoot/docs. */
export function resolveDoc(relativePath: string): string {
  return resolve(resolvePackageRoot(), 'docs', relativePath);
}

/** Resolve a task JSON path under dataDir/tasks/active. */
export function resolveTask(slug: string): string {
  return resolve(resolveDataDir(), 'tasks', 'active', `${slug}.task.json`);
}

/** Resolve the tasks/ directory under dataDir. Contains active/ and done/ subdirs. */
export function resolveTaskDir(): string {
  return resolve(resolveDataDir(), 'tasks');
}

/** Resolve the learnings/ directory under dataDir. */
export function resolveLearningsDir(): string {
  return resolve(resolveDataDir(), 'learnings');
}

/** Resolve the amendments/ directory under dataDir. */
export function resolveAmendmentsDir(): string {
  return resolve(resolveDataDir(), 'amendments');
}

/** Resolve the append-only run-log.jsonl path under dataDir. */
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
