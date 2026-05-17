import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectsManifest, resolveRepoPath } from '../config.js';
import { writeConfig } from '../data-dir.js';
import { EMBEDDED_PACKAGE_ROOT } from '../paths.js';

let tempDir: string;
const originalEnv = { ...process.env };

describe('projects config', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'case-config-'));
    process.env.CASE_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it('uses the configured projects file as the repo path base when package assets are embedded', async () => {
    await mkdir(join(tempDir, 'repos'), { recursive: true });
    await Bun.write(
      join(tempDir, 'projects.json'),
      JSON.stringify({
        repos: [
          {
            name: 'cli',
            type: 'library',
            path: 'repos/cli',
            remote: 'git@github.com:workos/workos-cli.git',
            language: 'typescript',
            packageManager: 'pnpm',
            commands: { test: 'pnpm test' },
          },
        ],
      }),
    );
    writeConfig({ projects: './projects.json' });

    const manifest = await loadProjectsManifest(EMBEDDED_PACKAGE_ROOT);

    expect(manifest.repoBasePath).toBe(tempDir);
    expect(resolveRepoPath(manifest.repoBasePath, manifest.repos[0]!.path)).toBe(join(tempDir, 'repos/cli'));
  });
});
