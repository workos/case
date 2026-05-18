import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { loadProjectsManifest } from '../config.js';
import { resolvePackageRoot } from '../paths.js';
import { runCommandLine } from '../util/run-command.js';
import type { EvidenceStrategy, ProjectEntry } from '../types.js';

export const description = 'Add a new repo to projects.json with auto-detected settings';

interface DetectedRepo {
  name: string;
  path: string;
  remote: string;
  language: string;
  packageManager: string;
  description: string;
  commands: Record<string, string>;
  evidenceStrategy: EvidenceStrategy;
}

export async function handler(argv: string[]): Promise<number> {
  const repoPath = argv[0];

  if (!repoPath || repoPath === '--help' || repoPath === '-h') {
    process.stderr.write('Usage: ca onboard <path-to-repo>\n');
    process.stderr.write('\nProbes the repo for package manager, language, scripts, and git remote.\n');
    process.stderr.write('Adds an entry to projects.json with the detected settings.\n');
    return repoPath ? 0 : 1;
  }

  const absPath = resolve(repoPath);
  if (!existsSync(absPath)) {
    process.stderr.write(`Error: path not found: ${absPath}\n`);
    return 1;
  }

  const caseRoot = resolvePackageRoot();
  const manifest = await loadProjectsManifest(caseRoot);

  const existing = manifest.repos.find(
    (r) => resolve(manifest.repoBasePath, r.path) === absPath || r.name === basename(absPath),
  );
  if (existing) {
    process.stderr.write(`Error: repo "${existing.name}" already in projects.json\n`);
    return 1;
  }

  process.stdout.write(`Probing ${absPath}...\n`);

  const detected = await probeRepo(absPath, manifest.repoBasePath);

  process.stdout.write(`\n  Name:             ${detected.name}\n`);
  process.stdout.write(`  Path:             ${detected.path}\n`);
  process.stdout.write(`  Remote:           ${detected.remote}\n`);
  process.stdout.write(`  Language:         ${detected.language}\n`);
  process.stdout.write(`  Package manager:  ${detected.packageManager}\n`);
  process.stdout.write(`  Evidence:         ${detected.evidenceStrategy}\n`);
  process.stdout.write(`  Description:      ${detected.description}\n`);
  process.stdout.write(`  Commands:\n`);
  for (const [key, cmd] of Object.entries(detected.commands)) {
    process.stdout.write(`    ${key}: ${cmd}\n`);
  }

  const entry: ProjectEntry = {
    name: detected.name,
    evidenceStrategy: detected.evidenceStrategy,
    path: detected.path,
    remote: detected.remote,
    description: detected.description,
    language: detected.language,
    packageManager: detected.packageManager,
    commands: detected.commands,
  };

  const raw = readFileSync(manifest.path, 'utf-8');
  const json = JSON.parse(raw) as { $schema?: string; repos: ProjectEntry[] };
  json.repos.push(entry);
  await Bun.write(manifest.path, JSON.stringify(json, null, 2) + '\n');

  process.stdout.write(`\nAdded "${detected.name}" to ${manifest.path}\n`);

  // Run bootstrap to validate
  process.stdout.write(`\nRunning bootstrap...\n`);
  const { runBootstrap } = await import('./bootstrap.js');
  try {
    const result = await runBootstrap(detected.name, caseRoot);
    for (const step of result.steps) {
      const seconds = (step.durationMs / 1000).toFixed(1);
      const tag = step.exitCode === 0 ? 'OK' : 'FAIL';
      process.stdout.write(`  [${tag}] ${step.label} (${seconds}s)\n`);
    }
    if (!result.ok) {
      process.stderr.write('Bootstrap failed. Entry was added but repo is not ready.\n');
      return 1;
    }
    process.stdout.write('Ready.\n');
  } catch (err) {
    process.stderr.write(`Bootstrap error: ${(err as Error).message}\n`);
    return 1;
  }

  return 0;
}

async function probeRepo(absPath: string, basePath: string): Promise<DetectedRepo> {
  const name = basename(absPath);
  const relPath = relative(basePath, absPath);
  const path = relPath.startsWith('.') ? relPath : `./${relPath}`;

  const remote = await detectRemote(absPath);
  const { language, packageManager, commands, description } = await detectFromPackageFile(absPath);
  const evidenceStrategy = inferEvidenceStrategy(absPath, commands);

  return { name, path, remote, language, packageManager, commands, description, evidenceStrategy };
}

async function detectRemote(repoPath: string): Promise<string> {
  const result = await runCommandLine('git remote get-url origin', { cwd: repoPath, timeout: 5_000 });
  return result.stdout.trim() || 'unknown';
}

interface PackageDetection {
  language: string;
  packageManager: string;
  commands: Record<string, string>;
  description: string;
}

async function detectFromPackageFile(repoPath: string): Promise<PackageDetection> {
  const pkgPath = resolve(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    return detectFromNodePackage(repoPath, pkgPath);
  }

  // Fallback: check for other ecosystems
  if (existsSync(resolve(repoPath, 'go.mod'))) {
    return { language: 'go', packageManager: 'go', commands: { setup: 'go mod download', test: 'go test ./...' }, description: '' };
  }
  if (existsSync(resolve(repoPath, 'pyproject.toml')) || existsSync(resolve(repoPath, 'setup.py'))) {
    return { language: 'python', packageManager: 'pip', commands: { setup: 'pip install -e .', test: 'pytest' }, description: '' };
  }
  if (existsSync(resolve(repoPath, 'Gemfile'))) {
    return { language: 'ruby', packageManager: 'bundler', commands: { setup: 'bundle install', test: 'bundle exec rspec' }, description: '' };
  }

  return { language: 'typescript', packageManager: 'npm', commands: { setup: 'npm install', test: 'npm test' }, description: '' };
}

function detectFromNodePackage(repoPath: string, pkgPath: string): PackageDetection {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const description: string = pkg.description ?? '';

  // Detect package manager
  let packageManager = 'npm';
  if (existsSync(resolve(repoPath, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (existsSync(resolve(repoPath, 'yarn.lock'))) packageManager = 'yarn';
  else if (existsSync(resolve(repoPath, 'bun.lockb')) || existsSync(resolve(repoPath, 'bun.lock'))) packageManager = 'bun';

  const run = (packageManager === 'npm' || packageManager === 'bun') ? `${packageManager} run` : packageManager;
  const commands: Record<string, string> = {};

  commands.setup = `${packageManager} install`;
  commands.test = scripts.test ? `${run} test` : `${packageManager} test`;
  if (scripts.build) commands.build = `${run} build`;
  if (scripts.lint) commands.lint = `${run} lint`;
  if (scripts.typecheck) commands.typecheck = `${run} typecheck`;
  if (scripts.format) commands.format = `${run} format`;

  const language = 'typescript';

  return { language, packageManager, commands, description };
}

export function inferEvidenceStrategy(repoPath: string, commands: Record<string, string>): EvidenceStrategy {
  // If there's a dev server script and an example app, likely a UI
  const pkgPath = resolve(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const scripts = pkg.scripts ?? {};

    // Has a dev server and is an app framework (Next.js, etc.)
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (scripts.dev && (deps.next || deps.vite || deps['@remix-run/dev'] || deps['@tanstack/start'])) {
      return 'ui-screenshot';
    }
  }

  // If there are example app directories, likely supports UI testing
  if (existsSync(resolve(repoPath, 'examples')) || existsSync(resolve(repoPath, 'example'))) {
    return 'ui-screenshot';
  }

  // Has test command → at minimum supports test-output; if it has a build, scenario-script is viable
  if (commands.build) return 'scenario-script';
  return 'test-output';
}
