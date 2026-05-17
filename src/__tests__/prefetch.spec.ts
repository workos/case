import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { prefetchRepoContext } from '../context/prefetch.js';
import type { PipelineConfig } from '../types.js';
import { mockGatherSessionContext, mockRunCommand } from './mocks.js';
import { EMBEDDED_PACKAGE_ROOT } from '../paths.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

let tempDir: string;
let repoDir: string;
let dataDir: string;
let packageRoot: string;

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'attended',
    taskJsonPath: join(repoDir, '.case/tasks/active/cli-1.task.json'),
    taskMdPath: join(repoDir, '.case/tasks/active/cli-1.md'),
    repoPath: repoDir,
    repoName: 'cli',
    packageRoot,
    dataDir: repoDir,
    maxRetries: 1,
    dryRun: false,
    ...overrides,
  };
}

describe('prefetchRepoContext', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = join(process.env.TMPDIR ?? '/tmp', `case-prefetch-test-${Date.now()}`);
    repoDir = join(tempDir, 'repo');
    dataDir = join(tempDir, 'data');
    packageRoot = join(tempDir, 'case');

    await mkdir(join(repoDir, '.case'), { recursive: true });
    await mkdir(join(dataDir, 'learnings'), { recursive: true });
    await mkdir(join(packageRoot, 'docs/learnings'), { recursive: true });

    process.env.CASE_DATA_DIR = dataDir;
    mockGatherSessionContext.mockReset();
    mockRunCommand.mockReset();
    mockGatherSessionContext.mockResolvedValue({ repo: 'cli' });
    mockRunCommand.mockResolvedValue({ stdout: 'abc123 recent commit\n', stderr: '', exitCode: 0 });
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prefers repo-local .case/learnings.md over global and legacy learnings', async () => {
    await Bun.write(join(repoDir, '.case/learnings.md'), 'repo-local learning\n');
    await Bun.write(join(dataDir, 'learnings/cli.md'), 'global learning\n');
    await Bun.write(join(packageRoot, 'docs/learnings/cli.md'), 'legacy learning\n');

    const context = await prefetchRepoContext(makeConfig(), 'implementer');

    expect(context.learnings).toBe('repo-local learning\n');
  });

  it('falls back to global learnings when repo-local learnings are absent', async () => {
    await Bun.write(join(dataDir, 'learnings/cli.md'), 'global learning\n');
    await Bun.write(join(packageRoot, 'docs/learnings/cli.md'), 'legacy learning\n');

    const context = await prefetchRepoContext(makeConfig(), 'implementer');

    expect(context.learnings).toBe('global learning\n');
  });

  it('reads golden principles from embedded package assets for reviewer context', async () => {
    const context = await prefetchRepoContext(makeConfig({ packageRoot: EMBEDDED_PACKAGE_ROOT }), 'reviewer');

    expect(context.goldenPrinciples).toContain('Golden Principles');
  });
});
