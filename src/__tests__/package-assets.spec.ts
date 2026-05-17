import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMBEDDED_PACKAGE_ROOT } from '../paths.js';
import { packageAssetExistsSync, readPackageAsset, readPackageAssetSync } from '../package-assets.js';

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
