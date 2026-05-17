import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findPriorRunId } from '../../src/versioning/prompt-tracker.js';

const originalEnv = { ...process.env };
let tmp: string;
let repoDir: string;
let dataDir: string;
let packageRoot: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'case-prompt-tracker-'));
  repoDir = join(tmp, 'target-repo');
  dataDir = join(tmp, 'data');
  packageRoot = join(tmp, 'case-package');

  await mkdir(repoDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(packageRoot, 'docs'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'case' }));

  process.env.CASE_DATA_DIR = dataDir;
  process.env.CASE_PACKAGE_ROOT = packageRoot;
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await rm(tmp, { recursive: true, force: true });
});

describe('findPriorRunId', () => {
  it('prefers the repo-local run log', async () => {
    await mkdir(join(repoDir, '.case'), { recursive: true });
    await writeFile(
      join(repoDir, '.case/run-log.jsonl'),
      [
        JSON.stringify({ task: 'task-1', runId: 'repo-old' }),
        JSON.stringify({ task: 'other', runId: 'other' }),
        JSON.stringify({ task: 'task-1', runId: 'repo-new' }),
      ].join('\n'),
    );
    await writeFile(join(dataDir, 'run-log.jsonl'), JSON.stringify({ task: 'task-1', runId: 'config-run' }));
    await writeFile(join(packageRoot, 'docs/run-log.jsonl'), JSON.stringify({ task: 'task-1', runId: 'legacy-run' }));

    expect(await findPriorRunId(repoDir, 'task-1')).toBe('repo-new');
  });

  it('falls back to the configured run log when repo-local state is absent', async () => {
    await writeFile(join(dataDir, 'run-log.jsonl'), JSON.stringify({ task: 'task-1', runId: 'config-run' }));
    await writeFile(join(packageRoot, 'docs/run-log.jsonl'), JSON.stringify({ task: 'task-1', runId: 'legacy-run' }));

    expect(await findPriorRunId(repoDir, 'task-1')).toBe('config-run');
  });

  it('uses the case package root for the pre-migration legacy run log', async () => {
    await mkdir(join(repoDir, 'docs'), { recursive: true });
    await writeFile(join(repoDir, 'docs/run-log.jsonl'), JSON.stringify({ task: 'task-1', runId: 'target-repo-run' }));
    await writeFile(join(packageRoot, 'docs/run-log.jsonl'), JSON.stringify({ task: 'task-1', runId: 'legacy-run' }));

    expect(await findPriorRunId(repoDir, 'task-1')).toBe('legacy-run');
  });
});
