/**
 * Data directory management.
 *
 * Owns user-level config/cache state under `resolveDataDir()` — `~/.config/case/` by default.
 *
 * Responsibilities:
 *   - `ensureDataDir()` — idempotent mkdir of the config/cache subtree.
 *   - `readConfig()`  — merge defaults over the on-disk config; never throws on missing/corrupt files.
 *   - `writeConfig()` — atomic temp-file-then-rename write with shallow merge.
 *   - `migrateFromRepo()` — one-time, non-destructive copy of user-level config/cache from an existing case repo.
 *
 * Pure module — no global state. Every function re-reads env via `resolveDataDir()` so tests
 * can swap the target dir per-test by setting `CASE_DATA_DIR`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveAgentVersionsDir, resolveConfigPath, resolveDataDir } from './paths.js';

export const CONFIG_VERSION = 1;

export interface CaseConfig {
  version: number;
  /** "<owner>/<repo>" for screenshot uploads. */
  assetsRepo: string;
  /** Path to projects.json (absolute or relative to data dir). */
  projects: string;
  /** Informational — consumed by the orchestrator/agents in a later phase. */
  defaultModel: string;
}

export const DEFAULT_CONFIG: CaseConfig = {
  version: CONFIG_VERSION,
  assetsRepo: 'nicknisi/case-assets',
  projects: './projects.json',
  defaultModel: 'claude-sonnet-4-6',
};

/** Subdirectories created under dataDir. Per-repo runtime state lives in target repo `.case/`. */
const DATA_SUBDIRS = ['agent-versions'] as const;

/**
 * Create the full data directory tree under `resolveDataDir()`.
 * Idempotent: safe to call on every CLI entry.
 *
 * Subdirs are created in priority order so a partial ENOSPC leaves config usable.
 */
export function ensureDataDir(): void {
  const root = resolveDataDir();
  mkdirSync(root, { recursive: true });
  for (const sub of DATA_SUBDIRS) {
    mkdirSync(join(root, sub), { recursive: true });
  }
}

/** Returns true if `config.json` exists at the resolved path. */
export function configExists(): boolean {
  return existsSync(resolveConfigPath());
}

/**
 * Read `config.json` and merge it over `DEFAULT_CONFIG`.
 *
 * Behavior:
 *   - Missing file → `{ ...DEFAULT_CONFIG }`.
 *   - Corrupt JSON → warn + return defaults (never throw — keeps the CLI usable).
 *   - Newer schema version → warn but merge best-effort.
 */
export function readConfig(): CaseConfig {
  const p = resolveConfigPath();
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch (err) {
    process.stderr.write(`case: warning — could not read config.json (${(err as Error).message}); using defaults.\n`);
    return { ...DEFAULT_CONFIG };
  }
  let parsed: Partial<CaseConfig> & { version?: number };
  try {
    parsed = JSON.parse(raw) as Partial<CaseConfig> & { version?: number };
  } catch (err) {
    process.stderr.write(
      `case: warning — config.json could not be parsed (${(err as Error).message}); using defaults.\n`,
    );
    return { ...DEFAULT_CONFIG };
  }
  if (typeof parsed.version === 'number' && parsed.version > CONFIG_VERSION) {
    process.stderr.write(
      `case: warning — config.json version ${parsed.version} is newer than supported ${CONFIG_VERSION}; some fields may be ignored.\n`,
    );
  }
  return { ...DEFAULT_CONFIG, ...parsed };
}

/**
 * Atomic shallow-merge write of `config.json`.
 *
 * Reads the current on-disk config (or defaults), merges `patch` over it, and writes
 * to `config.json.tmp` then renames. The temp+rename pattern minimizes the window
 * during which an interrupted write could leave a truncated file.
 *
 * The `version` field is always pinned to `CONFIG_VERSION` on write.
 */
export function writeConfig(patch: Partial<CaseConfig>): void {
  const current = readConfig();
  const next: CaseConfig = { ...current, ...patch, version: CONFIG_VERSION };
  const p = resolveConfigPath();
  // mkdir the parent so the very first write on a brand-new dataDir doesn't ENOENT.
  mkdirSync(resolveDataDir(), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, p);
}

export interface MigrationStats {
  tasks: number;
  learnings: number;
  amendments: number;
  runLog: boolean;
  agentVersions: number;
  projectsJson: boolean;
  conflicts: number;
}

/** Marker filename written under dataDir once migration completes successfully. */
const MIGRATED_MARKER = '.migrated';

/**
 * One-time, non-destructive migration of state from an existing case repo.
 *
 * Source layout (legacy):
 *   <repoRoot>/docs/agent-versions/
 *   <repoRoot>/projects.json (relative repo paths are rewritten to absolute paths)
 *
 * Behavior:
 *   - Skips entirely if `<dataDir>/.migrated` exists.
 *   - Never overwrites: existing files in dataDir are kept; `conflicts` counter increments.
 *   - Writes `.migrated` only on successful completion of the function — re-runs are safe.
 */
export async function migrateFromRepo(repoRoot: string): Promise<MigrationStats> {
  const stats: MigrationStats = {
    tasks: 0,
    learnings: 0,
    amendments: 0,
    runLog: false,
    agentVersions: 0,
    projectsJson: false,
    conflicts: 0,
  };

  const dataDir = resolveDataDir();
  const markerPath = join(dataDir, MIGRATED_MARKER);
  if (existsSync(markerPath)) return stats;

  ensureDataDir();

  // Per-repo runtime state (tasks, learnings, amendments, run logs) intentionally
  // stays with each target repo under `.case/`; `ca init` only migrates user-level
  // config/cache files.

  // agent-versions
  stats.agentVersions += copyDirShallow(resolve(repoRoot, 'docs/agent-versions'), resolveAgentVersionsDir(), stats);

  // projects.json — copy to dataDir root if not already present
  const projectsSrc = resolve(repoRoot, 'projects.json');
  const projectsDst = join(dataDir, 'projects.json');
  if (existsSync(projectsSrc)) {
    if (existsSync(projectsDst)) {
      stats.conflicts += 1;
    } else {
      copyProjectsManifest(projectsSrc, projectsDst, repoRoot);
      stats.projectsJson = true;
    }
  }

  // Drop the marker only on successful completion.
  writeFileSync(markerPath, new Date().toISOString() + '\n');

  return stats;
}

function copyProjectsManifest(src: string, dst: string, repoRoot: string): void {
  const raw = readFileSync(src, 'utf-8');
  try {
    const manifest = JSON.parse(raw) as { repos?: Array<{ path?: string }> };
    if (Array.isArray(manifest.repos)) {
      for (const repo of manifest.repos) {
        if (typeof repo.path === 'string' && repo.path && !isAbsolute(repo.path)) {
          repo.path = resolve(repoRoot, repo.path);
        }
      }
      writeFileSync(dst, JSON.stringify(manifest, null, 2) + '\n');
      return;
    }
  } catch {
    // Preserve unparseable manifests verbatim; loadProjects() will report the parse error later.
  }
  copyFileSync(src, dst);
}

/**
 * Copy regular files from `src` to `dst`. Subdirectories are skipped.
 * Existing files in `dst` are never overwritten — they bump `stats.conflicts`.
 *
 * Returns the number of files actually copied.
 */
function copyDirShallow(src: string, dst: string, stats: MigrationStats): number {
  if (!existsSync(src)) return 0;
  let copied = 0;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dst, entry);
    let info;
    try {
      info = statSync(from);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (existsSync(to)) {
      stats.conflicts += 1;
      continue;
    }
    copyFileSync(from, to);
    copied += 1;
  }
  return copied;
}

/**
 * Heuristic: detect whether `cwd` looks like the root of a case repo,
 * for auto-migration in `case init`.
 *
 * A case repo has `projects.json` AND `agents/` at its root.
 */
export function detectRepoRoot(cwd: string): string | undefined {
  const projects = resolve(cwd, 'projects.json');
  const agents = resolve(cwd, 'agents');
  if (existsSync(projects) && existsSync(agents)) return cwd;
  return undefined;
}
