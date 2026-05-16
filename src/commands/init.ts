/**
 * `ca init` — scaffold the data directory and write a default `config.json`.
 *
 * Idempotent and non-destructive: re-running prints the current path and exits 0.
 * Pass `--force` to rewrite `config.json` (state directories are never deleted).
 *
 * Migration: when invoked from a case repo root, or with `--migrate-from <path>`,
 * copies tasks/, docs/learnings/, docs/proposed-amendments/, docs/run-log.jsonl,
 * docs/agent-versions/, and projects.json into the data dir. A `.migrated` marker
 * is written on success so re-runs are no-ops.
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { resolveConfigPath, resolveDataDir } from '../paths.js';
import {
  configExists,
  detectRepoRoot,
  ensureDataDir,
  migrateFromRepo,
  writeConfig,
  type CaseConfig,
} from '../data-dir.js';

export const description = 'Scaffold the case data directory at ~/.config/case/';

export interface InitOptions {
  projects?: string;
  assetsRepo?: string;
  migrateFrom?: string;
  force?: boolean;
  cwd?: string;
}

export async function init(opts: InitOptions = {}): Promise<number> {
  const dataDir = resolveDataDir();
  ensureDataDir();

  const existing = configExists();
  if (existing && !opts.force) {
    process.stdout.write(`Case already initialized at ${dataDir}\n`);
    process.stdout.write(`Re-run with --force to rewrite config.json (state is preserved).\n`);
    return 0;
  }

  const patch: Partial<CaseConfig> = {};
  if (opts.projects) patch.projects = opts.projects;
  if (opts.assetsRepo) patch.assetsRepo = opts.assetsRepo;
  writeConfig(patch);

  const migrateSource = opts.migrateFrom ? resolve(opts.migrateFrom) : detectRepoRoot(opts.cwd ?? process.cwd());

  if (migrateSource) {
    try {
      const stats = await migrateFromRepo(migrateSource);
      const total = stats.tasks + stats.learnings + stats.amendments + stats.agentVersions;
      if (total > 0 || stats.runLog || stats.projectsJson) {
        process.stdout.write(
          `Migrated from ${migrateSource}: ${stats.tasks} task files, ${stats.learnings} learnings, ${stats.amendments} amendments, ${stats.agentVersions} agent-versions, run-log=${stats.runLog}, projects.json=${stats.projectsJson}.\n`,
        );
      }
      if (stats.conflicts > 0) {
        process.stdout.write(`Skipped ${stats.conflicts} existing file(s) — data dir was not empty.\n`);
      }
    } catch (err) {
      process.stderr.write(`case: migration from ${migrateSource} failed — ${(err as Error).message}\n`);
      return 1;
    }
  }

  process.stdout.write(`Case initialized at ${dataDir}\n`);
  process.stdout.write(`Config: ${resolveConfigPath()}\n`);
  return 0;
}

export async function handler(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        projects: { type: 'string' },
        'assets-repo': { type: 'string' },
        'migrate-from': { type: 'string' },
        force: { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`ca init: ${(err as Error).message}\n`);
    printHelp();
    return 1;
  }

  try {
    return await init({
      projects: parsed.values.projects as string | undefined,
      assetsRepo: parsed.values['assets-repo'] as string | undefined,
      migrateFrom: parsed.values['migrate-from'] as string | undefined,
      force: parsed.values.force as boolean | undefined,
    });
  } catch (err) {
    const msg =
      (err as NodeJS.ErrnoException).code === 'EACCES'
        ? `permission denied at ${resolveDataDir()} — try CASE_DATA_DIR=/writable/path`
        : (err as Error).message;
    process.stderr.write(`ca init: ${msg}\n`);
    return 1;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: ca init [options]',
      '',
      'Scaffold the case data directory (default: ~/.config/case/) and write config.json.',
      'Idempotent and non-destructive: re-running prints the current path and exits 0.',
      '',
      'Options:',
      '  --projects <path>       Path to projects.json (absolute or relative to data dir)',
      '  --assets-repo <owner/repo>  Override the screenshot upload target',
      '  --migrate-from <path>   Migrate state from an existing case repo',
      '  --force                 Rewrite config.json (state directories are never deleted)',
      '  --help, -h              Show this help',
      '',
      'Environment:',
      '  CASE_DATA_DIR           Override the data directory location',
      '  XDG_CONFIG_HOME         Standard XDG override (data dir = $XDG_CONFIG_HOME/case)',
      '',
    ].join('\n'),
  );
}
