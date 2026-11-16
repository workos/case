import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generatePackageAssets } from '../dev/generate-package-assets.js';
import { embeddedPackageAssets } from '../generated/package-assets.js';
import { EMBEDDED_PACKAGE_ROOT } from '../paths.js';
import { packageAssetExistsSync, readPackageAsset, readPackageAssetSync } from '../package-assets.js';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

let tempDir: string;

describe('package assets', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'case-package-assets-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('falls back to embedded assets when no package root exists on disk', () => {
    const content = readPackageAssetSync('docs/golden-principles.md', { packageRoot: EMBEDDED_PACKAGE_ROOT });

    expect(content).toContain('Golden Principles');
  });

  it('prefers disk assets so local development and tests can override embedded content', async () => {
    await mkdir(join(tempDir, 'agents'), { recursive: true });
    await Bun.write(join(tempDir, 'agents/implementer.md'), '# Local Implementer\n');

    const content = await readPackageAsset('agents/implementer.md', { packageRoot: tempDir });

    expect(content).toBe('# Local Implementer\n');
  });

  it('reports existence across disk and embedded assets', () => {
    expect(packageAssetExistsSync('agents/reviewer.md', { packageRoot: EMBEDDED_PACKAGE_ROOT })).toBe(true);
    expect(packageAssetExistsSync('agents/not-real.md', { packageRoot: EMBEDDED_PACKAGE_ROOT })).toBe(false);
  });
});

describe('package assets in a fresh checkout', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'case-package-assets-git-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('embeds only files git can see in this repository (tracked, or untracked and not ignored)', () => {
    // Same view as the generator. In a fresh checkout this is just the tracked files.
    const visible = new Set(
      git(REPO_ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean),
    );
    const keys = Object.keys(embeddedPackageAssets);

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !visible.has(key))).toEqual([]);
  });

  it('generator leaves out gitignored files and keeps tracked ones', async () => {
    git(tempDir, 'init', '-q');
    await Bun.write(join(tempDir, '.gitignore'), 'docs/local/\n');
    await Bun.write(join(tempDir, 'docs/tracked.md'), '# tracked\n');
    await Bun.write(join(tempDir, 'docs/local/ignored.md'), '# ignored\n');
    git(tempDir, 'add', '.gitignore', 'docs/tracked.md');

    const outPath = await generatePackageAssets(tempDir);
    const manifest = await readFile(outPath, 'utf-8');

    expect(manifest).toContain("'docs/tracked.md': asset0,");
    expect(manifest).not.toContain('docs/local/ignored.md');
  });

  it('generator keeps untracked files that git does not ignore', async () => {
    git(tempDir, 'init', '-q');
    await Bun.write(join(tempDir, 'docs/new.md'), '# new\n');

    const outPath = await generatePackageAssets(tempDir);
    const manifest = await readFile(outPath, 'utf-8');

    expect(manifest).toContain("'docs/new.md': asset0,");
  });
});
