import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, basename, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadProjectsManifest, type LoadedProjectsManifest } from '../config.js';
import { isEmbeddedPackageRoot, resolveDataDir, resolvePackageRoot } from '../paths.js';
import { runCommandLine } from '../util/run-command.js';
import { synthesizeProjectEntry, validateEvidenceStrategy } from '../interview/findings.js';
import { startInterviewSession } from '../interview/session.js';
import { writeClaudeLocal, writeLearnings, writeProjectsEntry } from '../interview/writers.js';
import type { EvidenceStrategy, InterviewFindings, ProjectEntry } from '../types.js';

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

interface OnboardFlags {
  /** Positional path argument (or repo name when reInterview is set). */
  argument?: string;
  /** Run the interactive interview after the mechanical probe. */
  interview: boolean;
  /** Re-interview an already-onboarded repo (argument is a repo name). */
  reInterview: boolean;
  help: boolean;
}

export async function handler(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);

  if (flags.help) {
    printUsage();
    return 0;
  }

  if (!flags.argument) {
    printUsage();
    return 1;
  }

  const caseRoot = resolvePackageRoot();

  if (flags.reInterview) {
    return runReInterview(flags.argument!, caseRoot);
  }

  return runOnboard(flags.argument!, caseRoot, { interview: flags.interview });
}

function parseFlags(argv: string[]): OnboardFlags {
  const flags: OnboardFlags = {
    interview: false,
    reInterview: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--interview') {
      flags.interview = true;
      continue;
    }
    if (arg === '--re-interview') {
      flags.reInterview = true;
      continue;
    }
    if (arg.startsWith('-')) {
      // Unknown flag — ignored for forward compatibility.
      continue;
    }
    if (!flags.argument) flags.argument = arg;
  }

  return flags;
}

function printUsage(): void {
  process.stderr.write('Usage: ca onboard <path-to-repo> [--interview]\n');
  process.stderr.write('       ca onboard <repo-name> --re-interview\n');
  process.stderr.write('\nProbes the repo for package manager, language, scripts, and git remote.\n');
  process.stderr.write('Adds an entry to projects.json with the detected settings.\n');
  process.stderr.write('\nFlags:\n');
  process.stderr.write('  --interview      Run the interviewer agent after the mechanical probe to capture\n');
  process.stderr.write('                   evidence strategy rationale, verification notes, conventions, and\n');
  process.stderr.write('                   repo learnings. Writes .case/learnings.md and CLAUDE.local.md in\n');
  process.stderr.write('                   addition to the projects.json entry.\n');
  process.stderr.write('  --re-interview   Re-run the interview for an already-onboarded repo. The argument\n');
  process.stderr.write('                   is a repo name from projects.json. The existing entry is replaced\n');
  process.stderr.write('                   in place and learnings/CLAUDE.local.md are refreshed.\n');
  process.stderr.write('  -h, --help       Show this help message.\n');
}

async function runOnboard(repoPath: string, caseRoot: string, options: { interview: boolean }): Promise<number> {
  // Suppress structured JSON logs during interactive onboarding — the human
  // is watching the terminal and doesn't need JSON-lines noise from probeRepo.
  if (options.interview && !process.env.CASE_DEBUG) {
    process.env.CASE_QUIET = '1';
  }

  const absPath = resolve(repoPath);
  if (!existsSync(absPath)) {
    process.stderr.write(`Error: path not found: ${absPath}\n`);
    return 1;
  }

  const manifest = await loadOrCreateManifest(caseRoot);

  const existing = manifest.repos.find(
    (r) => resolve(manifest.repoBasePath, r.path) === absPath || r.name === basename(absPath),
  );
  if (existing) {
    process.stderr.write(`Error: repo "${existing.name}" already in projects.json\n`);
    return 1;
  }

  process.stdout.write(`Probing ${absPath}...\n`);

  const detected = await probeRepo(absPath, manifest.repoBasePath);
  printDetected(detected);

  let entry: ProjectEntry = toMechanicalEntry(detected);
  let findings: InterviewFindings | null = null;

  if (options.interview) {
    findings = await startInterviewSession({
      repoPath: absPath,
      detected,
      caseRoot,
    });
    if (findings) {
      const validation = validateEvidenceStrategy(findings);
      for (const warning of validation.warnings) {
        process.stderr.write(`  Warning: ${warning}\n`);
      }
      entry = synthesizeProjectEntry(findings, detected);
    } else {
      process.stderr.write('  Interview yielded no findings — writing mechanical entry only.\n');
    }
  }

  try {
    writeProjectsEntry(manifest.path, entry);
  } catch (err) {
    process.stderr.write(`Error writing projects.json: ${(err as Error).message}\n`);
    return 1;
  }

  if (findings) {
    writeLearnings(absPath, findings);
    writeClaudeLocal(absPath, findings);
  }

  return runBootstrapStep(entry.name, caseRoot);
}

async function runReInterview(repoName: string, caseRoot: string): Promise<number> {
  if (!process.env.CASE_DEBUG) {
    process.env.CASE_QUIET = '1';
  }

  const manifest = await loadProjectsManifest(caseRoot).catch(() => null);
  if (!manifest) {
    process.stderr.write(`Error: projects.json not found. Run 'ca init' or 'ca onboard <path>' first.\n`);
    return 1;
  }

  const existing = manifest.repos.find((r) => r.name === repoName);
  if (!existing) {
    const available = manifest.repos.map((r) => r.name).join(', ') || '(none)';
    process.stderr.write(`Error: repo "${repoName}" not found in projects.json.\n` + `Available repos: ${available}\n`);
    return 1;
  }

  const absPath = resolve(manifest.repoBasePath, existing.path);
  if (!existsSync(absPath)) {
    process.stderr.write(`Error: repo path not found on disk: ${absPath}\n`);
    return 1;
  }

  process.stdout.write(`Re-interviewing ${existing.name} (${absPath})...\n`);

  const detected = await probeRepo(absPath, manifest.repoBasePath);
  printDetected(detected);

  const findings = await startInterviewSession({
    repoPath: absPath,
    detected,
    caseRoot,
    existingEntry: existing,
  });

  if (!findings) {
    process.stderr.write('Interview yielded no findings — projects.json unchanged.\n');
    return 1;
  }

  const validation = validateEvidenceStrategy(findings);
  for (const warning of validation.warnings) {
    process.stderr.write(`  Warning: ${warning}\n`);
  }

  const entry = synthesizeProjectEntry(findings, detected);
  entry.name = existing.name;

  try {
    writeProjectsEntry(manifest.path, entry, existing.name);
  } catch (err) {
    process.stderr.write(`Error updating projects.json: ${(err as Error).message}\n`);
    return 1;
  }

  writeLearnings(absPath, findings);
  writeClaudeLocal(absPath, findings);

  return runBootstrapStep(entry.name, caseRoot);
}

function toMechanicalEntry(detected: DetectedRepo): ProjectEntry {
  return {
    name: detected.name,
    evidenceStrategy: detected.evidenceStrategy,
    path: detected.path,
    remote: detected.remote,
    description: detected.description,
    language: detected.language,
    packageManager: detected.packageManager,
    commands: detected.commands,
  };
}

function printDetected(detected: DetectedRepo): void {
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
  process.stdout.write('\n');
}

async function runBootstrapStep(repoName: string, caseRoot: string): Promise<number> {
  process.stdout.write(`\nRunning bootstrap...\n`);
  const { runBootstrap } = await import('./bootstrap.js');
  try {
    const result = await runBootstrap(repoName, caseRoot);
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
    return 0;
  } catch (err) {
    process.stderr.write(`Bootstrap error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function loadOrCreateManifest(caseRoot: string): Promise<LoadedProjectsManifest> {
  try {
    return await loadProjectsManifest(caseRoot);
  } catch {
    const dataDir = resolveDataDir();
    const path = resolve(dataDir, 'projects.json');

    // Never overwrite an existing file — if loadProjectsManifest threw on a
    // file that exists (corrupt JSON, schema mismatch, etc.), creating a fresh
    // empty one would silently destroy the user's repo entries.
    if (existsSync(path)) {
      throw new Error(`projects.json exists at ${path} but could not be loaded. Fix or delete it manually.`);
    }

    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify({ $schema: './projects.schema.json', repos: [] }, null, 2) + '\n');
    process.stdout.write(`Created ${path}\n`);
    return { repos: [], path, repoBasePath: isEmbeddedPackageRoot(caseRoot) ? dataDir : caseRoot };
  }
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
    return {
      language: 'go',
      packageManager: 'go',
      commands: { setup: 'go mod download', test: 'go test ./...' },
      description: '',
    };
  }
  if (existsSync(resolve(repoPath, 'pyproject.toml')) || existsSync(resolve(repoPath, 'setup.py'))) {
    return {
      language: 'python',
      packageManager: 'pip',
      commands: { setup: 'pip install -e .', test: 'pytest' },
      description: '',
    };
  }
  if (existsSync(resolve(repoPath, 'Gemfile'))) {
    return {
      language: 'ruby',
      packageManager: 'bundler',
      commands: { setup: 'bundle install', test: 'bundle exec rspec' },
      description: '',
    };
  }

  return {
    language: 'typescript',
    packageManager: 'npm',
    commands: { setup: 'npm install', test: 'npm test' },
    description: '',
  };
}

function detectFromNodePackage(repoPath: string, pkgPath: string): PackageDetection {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const description: string = pkg.description ?? '';

  // Detect package manager
  let packageManager = 'npm';
  if (existsSync(resolve(repoPath, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (existsSync(resolve(repoPath, 'yarn.lock'))) packageManager = 'yarn';
  else if (existsSync(resolve(repoPath, 'bun.lockb')) || existsSync(resolve(repoPath, 'bun.lock')))
    packageManager = 'bun';

  const run = packageManager === 'npm' || packageManager === 'bun' ? `${packageManager} run` : packageManager;
  const commands: Record<string, string> = {};

  commands.setup = `${packageManager} install`;
  const isPlaceholderTest = !scripts.test || /echo\s+.*no test/i.test(scripts.test);
  if (!isPlaceholderTest) {
    commands.test = `${run} test`;
  }
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
