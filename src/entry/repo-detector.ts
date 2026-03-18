import { resolve } from 'node:path';
import { loadProjects, resolveRepoPath } from '../config.js';
import type { ProjectEntry } from '../types.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

export interface DetectedRepo {
  name: string;
  path: string;
  project: ProjectEntry;
}

/**
 * Normalize a git remote URL for comparison.
 * Handles SSH (git@github.com:org/repo.git) and HTTPS (https://github.com/org/repo.git).
 * Strips protocol, auth, `.git` suffix, and lowercases.
 */
export function normalizeRemoteUrl(url: string): string {
  let normalized = url.trim();

  // SSH: git@github.com:org/repo.git -> github.com/org/repo
  const sshMatch = normalized.match(/^[\w-]+@([^:]+):(.+)$/);
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // HTTPS: remove protocol and auth
    normalized = normalized.replace(/^https?:\/\//, '').replace(/^[^@]+@/, '');
  }

  // Strip trailing .git
  normalized = normalized.replace(/\.git$/, '');

  return normalized.toLowerCase();
}

/**
 * Extract owner/repo from a git remote URL.
 * e.g., `git@github.com:workos/workos-node.git` -> `workos/workos-node`
 */
export function extractOwnerRepo(remoteUrl: string): string {
  const normalized = normalizeRemoteUrl(remoteUrl);
  // normalized = "github.com/workos/workos-node" -> "workos/workos-node"
  const parts = normalized.split('/');
  if (parts.length >= 3) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return normalized;
}

/**
 * Detect which projects.json repo the user's cwd belongs to
 * by matching `git remote get-url origin` against repo remotes.
 */
export async function detectRepo(caseRoot: string, cwd?: string): Promise<DetectedRepo> {
  const workingDir = cwd ?? process.cwd();

  // Step 1: Get the git remote URL from cwd
  const remoteUrl = await getGitRemoteUrl(workingDir);

  // Step 2: Load projects and match
  const projects = await loadProjects(caseRoot);

  // Try matching by remote URL
  if (remoteUrl) {
    const normalizedCwd = normalizeRemoteUrl(remoteUrl);

    for (const project of projects) {
      if (normalizeRemoteUrl(project.remote) === normalizedCwd) {
        const repoPath = resolveRepoPath(caseRoot, project.path);
        log.info('repo detected via remote', { repo: project.name, remote: remoteUrl });
        return { name: project.name, path: repoPath, project };
      }
    }
  }

  // Fallback: try matching by resolved path
  const resolvedCwd = resolve(workingDir);
  for (const project of projects) {
    const resolvedProjectPath = resolve(resolveRepoPath(caseRoot, project.path));
    if (resolvedCwd === resolvedProjectPath || resolvedCwd.startsWith(resolvedProjectPath + '/')) {
      log.info('repo detected via path', { repo: project.name, cwd: resolvedCwd });
      return { name: project.name, path: resolvedProjectPath, project };
    }
  }

  // No match — error with helpful listing
  const knownRepos = projects.map((p) => `  ${p.name} (${p.remote})`).join('\n');
  throw new Error(`Repo not found in projects.json for cwd: ${workingDir}\nKnown repos:\n${knownRepos}`);
}

/** Run `git remote get-url origin` in the given directory. Returns URL or null. */
async function getGitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', 'remote', 'get-url', 'origin'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return null;
    }

    return stdout.trim() || null;
  } catch {
    return null;
  }
}
