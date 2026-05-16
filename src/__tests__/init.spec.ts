import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { init, handler } from '../commands/init.js';
import { DEFAULT_CONFIG } from '../data-dir.js';

let tmp: string;
const originalEnv = { ...process.env };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'case-init-'));
  process.env.CASE_DATA_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await rm(tmp, { recursive: true, force: true });
});

describe('init (programmatic)', () => {
  it('first run scaffolds the data dir and writes default config', async () => {
    const code = await init({ cwd: '/no/such/repo' });
    expect(code).toBe(0);
    const cfg = JSON.parse(await readFile(join(tmp, 'config.json'), 'utf-8'));
    expect(cfg.version).toBe(DEFAULT_CONFIG.version);
    expect(cfg.assetsRepo).toBe(DEFAULT_CONFIG.assetsRepo);
    expect(cfg.defaultModel).toBe(DEFAULT_CONFIG.defaultModel);
    await stat(join(tmp, 'tasks/active'));
    await stat(join(tmp, 'tasks/done'));
    await stat(join(tmp, 'learnings'));
    await stat(join(tmp, 'amendments'));
    await stat(join(tmp, 'agent-versions'));
  });

  it('second run is idempotent: same mtime, exits 0', async () => {
    await init({ cwd: '/no/such/repo' });
    const before = (await stat(join(tmp, 'config.json'))).mtimeMs;
    // Add a small delay would still satisfy the contract; we assert the file is unmodified.
    const code = await init({ cwd: '/no/such/repo' });
    const after = (await stat(join(tmp, 'config.json'))).mtimeMs;
    expect(code).toBe(0);
    expect(after).toBe(before);
  });

  it('--force rewrites config.json', async () => {
    await init({ cwd: '/no/such/repo' });
    const code = await init({ cwd: '/no/such/repo', force: true, assetsRepo: 'me/forked' });
    expect(code).toBe(0);
    const cfg = JSON.parse(await readFile(join(tmp, 'config.json'), 'utf-8'));
    expect(cfg.assetsRepo).toBe('me/forked');
  });

  it('--force preserves existing state directories', async () => {
    await init({ cwd: '/no/such/repo' });
    await writeFile(join(tmp, 'tasks/active/keep.task.json'), '{}');
    await init({ cwd: '/no/such/repo', force: true });
    await stat(join(tmp, 'tasks/active/keep.task.json'));
  });

  it('flag overrides land in config.json', async () => {
    await init({ cwd: '/no/such/repo', assetsRepo: 'me/x', projects: '/abs/path/projects.json' });
    const cfg = JSON.parse(await readFile(join(tmp, 'config.json'), 'utf-8'));
    expect(cfg.assetsRepo).toBe('me/x');
    expect(cfg.projects).toBe('/abs/path/projects.json');
  });

  it('--migrate-from triggers migrateFromRepo and reports stats', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'case-repo-'));
    try {
      await mkdir(join(repo, 'tasks/active'), { recursive: true });
      await mkdir(join(repo, 'docs/learnings'), { recursive: true });
      await writeFile(join(repo, 'tasks/active/foo.task.json'), '{"id":"foo"}');
      await writeFile(join(repo, 'docs/learnings/cli.md'), '# cli');
      await writeFile(join(repo, 'projects.json'), '{"repos":[]}');

      const code = await init({ migrateFrom: repo, cwd: '/no/such/repo' });
      expect(code).toBe(0);
      await stat(join(tmp, 'tasks/active/foo.task.json'));
      await stat(join(tmp, 'learnings/cli.md'));
      await stat(join(tmp, '.migrated'));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('auto-detects a case repo from cwd (projects.json + agents/)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'case-repo-'));
    try {
      await mkdir(join(repo, 'agents'));
      await mkdir(join(repo, 'tasks/active'), { recursive: true });
      await writeFile(join(repo, 'projects.json'), '{"repos":[]}');
      await writeFile(join(repo, 'tasks/active/auto.task.json'), '{"id":"auto"}');

      const code = await init({ cwd: repo });
      expect(code).toBe(0);
      await stat(join(tmp, 'tasks/active/auto.task.json'));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('handler (argv parsing)', () => {
  it('parses --help and exits 0 without writing anything', async () => {
    const code = await handler(['--help']);
    expect(code).toBe(0);
    // Did not create config.json
    let exists = false;
    try {
      await stat(join(tmp, 'config.json'));
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('rejects unknown flags', async () => {
    const code = await handler(['--bogus']);
    expect(code).toBe(1);
  });

  it('writes the data dir on a no-arg call', async () => {
    // Use a cwd without projects.json so migration is skipped
    const originalCwd = process.cwd;
    process.cwd = () => '/no/such/repo';
    try {
      const code = await handler([]);
      expect(code).toBe(0);
      await stat(join(tmp, 'config.json'));
    } finally {
      process.cwd = originalCwd;
    }
  });
});
