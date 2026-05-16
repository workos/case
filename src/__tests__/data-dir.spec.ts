import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  configExists,
  detectRepoRoot,
  ensureDataDir,
  migrateFromRepo,
  readConfig,
  writeConfig,
} from '../data-dir.js';

let tmp: string;
const originalEnv = { ...process.env };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'case-data-dir-'));
  // Isolate CASE_DATA_DIR per test. Other case paths fall back through this.
  process.env.CASE_DATA_DIR = tmp;
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await rm(tmp, { recursive: true, force: true });
});

describe('ensureDataDir', () => {
  it('creates the full subtree on an empty dir', async () => {
    ensureDataDir();
    const entries = await readdir(tmp);
    expect(entries.sort()).toEqual(['agent-versions', 'amendments', 'learnings', 'tasks']);
    const tasksSub = await readdir(join(tmp, 'tasks'));
    expect(tasksSub.sort()).toEqual(['active', 'done']);
  });

  it('is idempotent — second call does not throw and produces the same tree', async () => {
    ensureDataDir();
    ensureDataDir();
    const entries = await readdir(tmp);
    expect(entries.sort()).toEqual(['agent-versions', 'amendments', 'learnings', 'tasks']);
  });

  it('preserves files placed in subdirs across reruns', async () => {
    ensureDataDir();
    await writeFile(join(tmp, 'tasks/active/x.task.json'), '{}');
    ensureDataDir();
    const after = await readdir(join(tmp, 'tasks/active'));
    expect(after).toEqual(['x.task.json']);
  });
});

describe('readConfig', () => {
  it('returns DEFAULT_CONFIG when the file is missing', () => {
    const cfg = readConfig();
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('merges partial files over defaults', async () => {
    await writeFile(join(tmp, 'config.json'), JSON.stringify({ assetsRepo: 'me/assets' }));
    const cfg = readConfig();
    expect(cfg.assetsRepo).toBe('me/assets');
    expect(cfg.defaultModel).toBe(DEFAULT_CONFIG.defaultModel);
    expect(cfg.projects).toBe(DEFAULT_CONFIG.projects);
    expect(cfg.version).toBe(CONFIG_VERSION);
  });

  it('returns defaults and warns on corrupt JSON', async () => {
    const warn = mock(() => true);
    const original = process.stderr.write;
    // @ts-expect-error patching a method for assertion
    process.stderr.write = warn;
    try {
      await writeFile(join(tmp, 'config.json'), '{ not json');
      const cfg = readConfig();
      expect(cfg).toEqual(DEFAULT_CONFIG);
      expect(warn).toHaveBeenCalled();
    } finally {
      process.stderr.write = original;
    }
  });

  it('warns on future schema version but still merges best-effort', async () => {
    const warn = mock(() => true);
    const original = process.stderr.write;
    // @ts-expect-error patching a method for assertion
    process.stderr.write = warn;
    try {
      await writeFile(join(tmp, 'config.json'), JSON.stringify({ version: 999, assetsRepo: 'fork/assets' }));
      const cfg = readConfig();
      expect(cfg.assetsRepo).toBe('fork/assets');
      expect(warn).toHaveBeenCalled();
    } finally {
      process.stderr.write = original;
    }
  });
});

describe('writeConfig', () => {
  it('writes a fresh config when the file is missing', async () => {
    writeConfig({ assetsRepo: 'fork/assets' });
    const raw = await readFile(join(tmp, 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.assetsRepo).toBe('fork/assets');
    expect(parsed.version).toBe(CONFIG_VERSION);
  });

  it('preserves unrelated fields on shallow merge', async () => {
    await writeFile(
      join(tmp, 'config.json'),
      JSON.stringify({ version: CONFIG_VERSION, defaultModel: 'custom-model', assetsRepo: 'a/b' }),
    );
    writeConfig({ assetsRepo: 'c/d' });
    const cfg = readConfig();
    expect(cfg.defaultModel).toBe('custom-model');
    expect(cfg.assetsRepo).toBe('c/d');
  });

  it('pins version to CONFIG_VERSION on every write', async () => {
    writeConfig({ version: 999 as unknown as number });
    const cfg = readConfig();
    expect(cfg.version).toBe(CONFIG_VERSION);
  });

  it('uses an atomic temp-file-then-rename', async () => {
    // Real atomicity is hard to assert; sanity-check that no .tmp lingers after success.
    writeConfig({ assetsRepo: 'me/x' });
    const entries = await readdir(tmp);
    expect(entries).not.toContain('config.json.tmp');
    expect(entries).toContain('config.json');
  });
});

describe('configExists', () => {
  it('returns false before any write', () => {
    expect(configExists()).toBe(false);
  });

  it('returns true after a write', () => {
    writeConfig({});
    expect(configExists()).toBe(true);
  });
});

describe('migrateFromRepo', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'case-fake-repo-'));
    await mkdir(join(repoRoot, 'tasks/active'), { recursive: true });
    await mkdir(join(repoRoot, 'tasks/done'), { recursive: true });
    await mkdir(join(repoRoot, 'docs/learnings'), { recursive: true });
    await mkdir(join(repoRoot, 'docs/proposed-amendments'), { recursive: true });
    await mkdir(join(repoRoot, 'docs/agent-versions'), { recursive: true });
    await writeFile(join(repoRoot, 'tasks/active/t1.task.json'), '{"id":"t1"}');
    await writeFile(join(repoRoot, 'tasks/active/t1.md'), '# t1');
    await writeFile(join(repoRoot, 'tasks/done/t0.task.json'), '{"id":"t0"}');
    await writeFile(join(repoRoot, 'docs/learnings/cli.md'), '# cli learnings');
    await writeFile(join(repoRoot, 'docs/proposed-amendments/2026-05-01.md'), '# amendment');
    await writeFile(join(repoRoot, 'docs/run-log.jsonl'), '{"runId":"x"}\n');
    await writeFile(join(repoRoot, 'docs/agent-versions/implementer-2026-05-01.md'), '# snap');
    await writeFile(join(repoRoot, 'projects.json'), '{"repos":[]}');
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('copies state from a fake repo into the data dir', async () => {
    const stats = await migrateFromRepo(repoRoot);
    expect(stats.tasks).toBe(3); // 2 active + 1 done (only files counted)
    expect(stats.learnings).toBe(1);
    expect(stats.amendments).toBe(1);
    expect(stats.runLog).toBe(true);
    expect(stats.agentVersions).toBe(1);
    expect(stats.projectsJson).toBe(true);

    // Check files actually exist in dataDir
    await stat(join(tmp, 'tasks/active/t1.task.json'));
    await stat(join(tmp, 'tasks/done/t0.task.json'));
    await stat(join(tmp, 'learnings/cli.md'));
    await stat(join(tmp, 'amendments/2026-05-01.md'));
    await stat(join(tmp, 'run-log.jsonl'));
    await stat(join(tmp, 'agent-versions/implementer-2026-05-01.md'));
    await stat(join(tmp, 'projects.json'));
  });

  it('writes a .migrated marker on success', async () => {
    await migrateFromRepo(repoRoot);
    const marker = await stat(join(tmp, '.migrated'));
    expect(marker.isFile()).toBe(true);
  });

  it('is a no-op on the second call (marker short-circuits)', async () => {
    await migrateFromRepo(repoRoot);
    // Mutate the dataDir to detect any unexpected copy
    await writeFile(join(tmp, 'tasks/active/sentinel.task.json'), '{"id":"s"}');
    const stats = await migrateFromRepo(repoRoot);
    expect(stats.tasks).toBe(0);
    expect(stats.learnings).toBe(0);
    const after = await readdir(join(tmp, 'tasks/active'));
    expect(after.sort()).toEqual(['sentinel.task.json', 't1.md', 't1.task.json']);
  });

  it('never overwrites existing files', async () => {
    // Pre-populate the dataDir with a conflicting file
    ensureDataDir();
    await writeFile(join(tmp, 'tasks/active/t1.task.json'), '{"id":"already-here"}');
    const stats = await migrateFromRepo(repoRoot);
    expect(stats.conflicts).toBeGreaterThan(0);
    const kept = await readFile(join(tmp, 'tasks/active/t1.task.json'), 'utf-8');
    expect(kept).toBe('{"id":"already-here"}');
  });

  it('does nothing when the source repo has no state dirs', async () => {
    const emptyRepo = await mkdtemp(join(tmpdir(), 'case-empty-repo-'));
    try {
      const stats = await migrateFromRepo(emptyRepo);
      expect(stats.tasks).toBe(0);
      expect(stats.learnings).toBe(0);
      expect(stats.amendments).toBe(0);
      expect(stats.runLog).toBe(false);
      expect(stats.projectsJson).toBe(false);
    } finally {
      await rm(emptyRepo, { recursive: true, force: true });
    }
  });
});

describe('detectRepoRoot', () => {
  it('returns cwd when it contains projects.json and agents/', async () => {
    const fake = await mkdtemp(join(tmpdir(), 'case-detect-'));
    try {
      await writeFile(join(fake, 'projects.json'), '{}');
      await mkdir(join(fake, 'agents'));
      expect(detectRepoRoot(fake)).toBe(fake);
    } finally {
      await rm(fake, { recursive: true, force: true });
    }
  });

  it('returns undefined when only projects.json is present', async () => {
    const fake = await mkdtemp(join(tmpdir(), 'case-detect-'));
    try {
      await writeFile(join(fake, 'projects.json'), '{}');
      expect(detectRepoRoot(fake)).toBeUndefined();
    } finally {
      await rm(fake, { recursive: true, force: true });
    }
  });

  it('returns undefined for an unrelated directory', async () => {
    const fake = await mkdtemp(join(tmpdir(), 'case-detect-'));
    try {
      expect(detectRepoRoot(fake)).toBeUndefined();
    } finally {
      await rm(fake, { recursive: true, force: true });
    }
  });
});
