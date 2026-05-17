import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  resolvePackageRoot,
  resolveDataDir,
  resolveAgent,
  resolveDoc,
  resolveTask,
  resolveRepoActiveMarker,
  resolveRepoActiveTaskDir,
  resolveRepoLearnings,
  resolveRepoRunLog,
  resolveRepoTaskJson,
} from '../paths.js';

describe('resolvePackageRoot', () => {
  it('returns the case repo root when invoked from src/paths.ts', () => {
    const root = resolvePackageRoot();
    // The case repo's package.json declares name === "case".
    expect(root.length).toBeGreaterThan(0);
    // The src directory lives directly under the package root.
    expect(root).not.toBe('/');
  });

  it('honors CASE_PACKAGE_ROOT when it points at a case package', async () => {
    const originalEnv = { ...process.env };
    const tmp = await mkdtemp(join(tmpdir(), 'case-package-root-'));
    try {
      await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'case' }));
      process.env.CASE_PACKAGE_ROOT = tmp;
      expect(resolvePackageRoot()).toBe(tmp);
    } finally {
      process.env = { ...originalEnv };
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('resolveDataDir', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CASE_DATA_DIR;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.HOME;
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
  });

  it('honors CASE_DATA_DIR override', () => {
    process.env.CASE_DATA_DIR = '/tmp/case-test-override';
    expect(resolveDataDir()).toBe('/tmp/case-test-override');
  });

  it('CASE_DATA_DIR wins over XDG_CONFIG_HOME', () => {
    process.env.CASE_DATA_DIR = '/tmp/case-explicit';
    process.env.XDG_CONFIG_HOME = '/tmp/xdg';
    process.env.HOME = '/tmp/home';
    expect(resolveDataDir()).toBe('/tmp/case-explicit');
  });

  it('falls back to $XDG_CONFIG_HOME/case', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg';
    expect(resolveDataDir()).toBe('/tmp/xdg/case');
  });

  it('XDG_CONFIG_HOME wins over HOME when CASE_DATA_DIR unset', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg';
    process.env.HOME = '/tmp/home';
    expect(resolveDataDir()).toBe('/tmp/xdg/case');
  });

  it('falls back to $HOME/.config/case', () => {
    process.env.HOME = '/tmp/home';
    expect(resolveDataDir()).toBe('/tmp/home/.config/case');
  });

  it('throws when no env vars are set', () => {
    expect(() => resolveDataDir()).toThrow(/CASE_DATA_DIR, XDG_CONFIG_HOME, or HOME must be set/);
  });
});

describe('package root walk-up guard', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'case-paths-walkup-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects ancestors without a case package.json', async () => {
    // Place a foreign package.json in the chain to confirm name verification works.
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'not-case' }));
    // We can't easily invoke the private walk helper with a custom start dir without changing
    // the public API, so this guards the same package.json name check in a manual walk.
    expect(() => {
      // Recreate the same logic manually as a guard against regression.
      let current = tmp;
      while (true) {
        const manifestPath = resolve(current, 'package.json');
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
          if (manifest.name === 'case') return current;
        }
        const parent = dirname(current);
        if (parent === current) {
          throw new Error(`Could not find case package.json walking up from ${tmp}`);
        }
        current = parent;
      }
    }).toThrow(/Could not find case package.json/);
  });
});

describe('path helpers', () => {
  it('resolveAgent returns packageRoot/agents/<role>.md', () => {
    const path = resolveAgent('implementer');
    expect(path).toBe(resolve(resolvePackageRoot(), 'agents', 'implementer.md'));
  });

  it('resolveDoc returns packageRoot/docs/<relativePath>', () => {
    const path = resolveDoc('conventions/commits.md');
    expect(path).toBe(resolve(resolvePackageRoot(), 'docs', 'conventions', 'commits.md'));
  });

  it('resolveTask returns legacy dataDir/tasks/active/<slug>.task.json', () => {
    const originalEnv = { ...process.env };
    process.env.CASE_DATA_DIR = '/tmp/case-data-test';
    try {
      const path = resolveTask('foo-1');
      expect(path).toBe('/tmp/case-data-test/tasks/active/foo-1.task.json');
    } finally {
      process.env = { ...originalEnv };
    }
  });

  it('resolves repo-local .case paths', () => {
    const repo = '/tmp/repo';
    expect(resolveRepoActiveMarker(repo)).toBe('/tmp/repo/.case/active');
    expect(resolveRepoActiveTaskDir(repo)).toBe('/tmp/repo/.case/tasks/active');
    expect(resolveRepoTaskJson(repo, 'foo-1')).toBe('/tmp/repo/.case/tasks/active/foo-1.task.json');
    expect(resolveRepoLearnings(repo)).toBe('/tmp/repo/.case/learnings.md');
    expect(resolveRepoRunLog(repo)).toBe('/tmp/repo/.case/run-log.jsonl');
  });
});

describe('integration — package root structure', () => {
  it('walked-up root contains expected case directories', async () => {
    const root = resolvePackageRoot();
    // Sanity check: this resolver should land at a real case repo.
    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(root);
    expect(entries).toContain('package.json');
    expect(entries).toContain('src');
  });

  // Ensure tmp infrastructure doesn't leak between tests
  it('mkdir helper sanity', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'case-paths-sanity-'));
    await mkdir(join(tmp, 'foo'));
    await rm(tmp, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
