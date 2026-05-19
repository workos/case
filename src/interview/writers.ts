/**
 * Output writers for `ca onboard --interview`.
 *
 * Each writer takes the synthesized output of {@link ../interview/findings.ts}
 * and persists it to disk:
 *
 *   - {@link writeProjectsEntry} updates `projects.json` (appends new entries
 *     or replaces existing ones in-place during `--re-interview`).
 *   - {@link writeLearnings} writes the seed `<repo>/.case/learnings.md`,
 *     appending if a file already exists so we never blow away curated content.
 *   - {@link writeClaudeLocal} writes `<repo>/CLAUDE.local.md`. Because the
 *     content is generated from the interview (not hand-written), this writer
 *     overwrites on every run.
 *
 * All writers validate before they touch disk and report a one-line
 * confirmation to stdout so the user sees what changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveRepoCaseDir, resolveRepoClaudeLocal, resolveRepoLearnings } from '../paths.js';
import type { InterviewFindings, ProjectEntry } from '../types.js';
import { synthesizeClaudeLocal, synthesizeLearnings } from './findings.js';

interface ProjectsManifestFile {
  $schema?: string;
  repos: ProjectEntry[];
}

/**
 * Append or replace a project entry in `projects.json` on disk.
 *
 * - When `existingName` is provided and matches an entry, that entry is replaced
 *   in-place (used by `--re-interview`).
 * - Otherwise the entry is appended.
 *
 * The manifest is validated as JSON before writing — if the file is malformed,
 * the writer throws so the caller can surface a clean error instead of
 * silently overwriting corrupt data.
 */
export function writeProjectsEntry(manifestPath: string, entry: ProjectEntry, existingName?: string): void {
  if (!existsSync(manifestPath)) {
    throw new Error(`projects.json not found at ${manifestPath}`);
  }

  const raw = readFileSync(manifestPath, 'utf-8');
  let parsed: ProjectsManifestFile;
  try {
    parsed = JSON.parse(raw) as ProjectsManifestFile;
  } catch (err) {
    throw new Error(`projects.json parse error at ${manifestPath}: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.repos)) {
    throw new Error(`projects.json at ${manifestPath} is missing a "repos" array`);
  }

  const targetName = existingName ?? entry.name;
  const existingIndex = parsed.repos.findIndex((r) => r.name === targetName);

  if (existingName !== undefined) {
    if (existingIndex === -1) {
      throw new Error(`projects.json: cannot replace "${existingName}" — no such repo`);
    }
    parsed.repos[existingIndex] = entry;
  } else if (existingIndex !== -1) {
    // Defensive: caller passed no existingName but the name already exists.
    parsed.repos[existingIndex] = entry;
  } else {
    parsed.repos.push(entry);
  }

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + '\n');

  const action = existingName !== undefined ? 'Updated' : 'Wrote';
  process.stdout.write(`  ${action} projects.json (${entry.name}, evidenceStrategy: ${entry.evidenceStrategy})\n`);
}

/**
 * Write the seed `<repo>/.case/learnings.md`.
 *
 * - If the file doesn't exist, the synthesized markdown is written as-is.
 * - If it exists, the synthesized content is appended under a separator so we
 *   never overwrite previously curated learnings.
 * - When the interview produced no learnings, the writer is a no-op.
 */
export function writeLearnings(repoPath: string, findings: InterviewFindings): void {
  const body = synthesizeLearnings(findings);
  if (body.length === 0) {
    process.stdout.write(`  Skipped .case/learnings.md (no learnings captured)\n`);
    return;
  }

  const target = resolveRepoLearnings(repoPath);
  mkdirSync(resolveRepoCaseDir(repoPath), { recursive: true });

  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf-8');
    const separator = existing.endsWith('\n\n') || existing.endsWith('\n') ? '' : '\n';
    const appended = `${existing}${separator}\n---\n\n${body}`;
    writeFileSync(target, appended);
    process.stdout.write(`  Appended .case/learnings.md (${findings.learnings.length} new entries)\n`);
    return;
  }

  writeFileSync(target, body);
  process.stdout.write(`  Wrote .case/learnings.md (${findings.learnings.length} entries)\n`);
}

/**
 * Write `<repo>/CLAUDE.local.md` with the interview's conventions.
 *
 * The file is treated as generated content — every interview overwrites it.
 * When the interview produced no conventions, the writer is a no-op (we do
 * not want to clobber an existing hand-written CLAUDE.local.md with an empty
 * file).
 */
export function writeClaudeLocal(repoPath: string, findings: InterviewFindings): void {
  const body = synthesizeClaudeLocal(findings);
  if (body.length === 0) {
    process.stdout.write(`  Skipped CLAUDE.local.md (no conventions captured)\n`);
    return;
  }

  const target = resolveRepoClaudeLocal(repoPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  process.stdout.write(`  Wrote CLAUDE.local.md (${findings.conventions.length} conventions)\n`);
}
