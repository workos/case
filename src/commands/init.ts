/**
 * `ca init` — scaffold the user config directory and write a default `config.json`.
 *
 * Idempotent and non-destructive: re-running prints the current path and exits 0.
 * Pass `--force` to rewrite `config.json` (state directories are never deleted).
 *
 * Migration: when invoked from a case repo root, or with `--migrate-from <path>`,
 * copies docs/agent-versions/ and projects.json into the config dir. Per-repo
 * runtime state lives under each target repo's `.case/`.
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

export const description = 'Scaffold the case config directory at ~/.config/case/';

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
      const total = stats.agentVersions;
      if (total > 0 || stats.runLog || stats.projectsJson) {
        process.stdout.write(
          `Migrated from ${migrateSource}: ${stats.agentVersions} agent-versions, projects.json=${stats.projectsJson}.\n`,
        );
      }
      if (stats.conflicts > 0) {
        process.stdout.write(`Skipped ${stats.conflicts} existing file(s) — config dir was not empty.\n`);
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
      'Scaffold the case config directory (default: ~/.config/case/) and write config.json.',
      'Per-repo task runtime state is stored under each target repo .case/ directory.',
      '',
      'Options:',
      '  --projects <path>       Path to projects.json (absolute or relative to config dir)',
      '  --assets-repo <owner/repo>  Override the screenshot upload target',
      '  --migrate-from <path>   Migrate state from an existing case repo',
      '  --force                 Rewrite config.json (state directories are never deleted)',
      '  --help, -h              Show this help',
      '',
      'Portable binaries read package docs/prompts from the executable. Keep repo paths',
      'in projects.json absolute or relative to the projects.json file.',
      '',
      'Environment:',
      '  CASE_DATA_DIR           Override the config/cache directory location',
      '  XDG_CONFIG_HOME         Standard XDG override (config dir = $XDG_CONFIG_HOME/case)',
      '',
    ].join('\n'),
  );
}
