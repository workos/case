import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { findTaskByIssue, findTaskByMarker } from '../entry/task-scanner.js';
import type { TaskJson } from '../types.js';
import { mkdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';

let tempDir: string;
let repoDir: string;

function makeTaskJson(overrides: Partial<TaskJson> = {}): TaskJson {
  return {
    id: 'cli-abc-fix-test',
    status: 'active',
    created: '2026-03-14T00:00:00Z',
    repo: 'cli',
    issue: '1523',
    issueType: 'github',
    branch: 'fix/issue-1523',
    agents: {},
    tested: false,
    manualTested: false,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

async function writeLegacyTask(taskId: string, task: TaskJson): Promise<string> {
  const taskJsonPath = join(tempDir, 'tasks/active', `${taskId}.task.json`);
  await mkdir(join(tempDir, 'tasks/active'), { recursive: true });
  await Bun.write(taskJsonPath, JSON.stringify(task, null, 2));
  return taskJsonPath;
}

async function writeRepoTask(taskId: string, task: TaskJson): Promise<string> {
  const taskJsonPath = join(repoDir, '.case/tasks/active', `${taskId}.task.json`);
  await mkdir(join(repoDir, '.case/tasks/active'), { recursive: true });
  await Bun.write(taskJsonPath, JSON.stringify(task, null, 2));
  return taskJsonPath;
}

describe('task-scanner', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = join(process.env.TMPDIR ?? '/tmp', `case-scanner-test-${Date.now()}`);
    repoDir = join(tempDir, 'repo');
    await mkdir(join(repoDir, '.case/tasks/active'), { recursive: true });
    // Point the legacy data-dir fallback at a sibling temp dir so tests can
    // explicitly distinguish repo-local state from legacy state.
    process.env.CASE_DATA_DIR = join(tempDir, '.case-data-empty');
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('findTaskByIssue', () => {
    it('returns matching task with correct entry phase', async () => {
      const task = makeTaskJson();
      await writeRepoTask('cli-abc-fix-test', task);

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523', repoDir);

      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe('cli-abc-fix-test');
      expect(result!.taskJson.issue).toBe('1523');
      expect(result!.entryPhase).toBe('implement');
      expect(result!.taskJsonPath).toContain('cli-abc-fix-test.task.json');
      expect(result!.taskJsonPath).toContain(join('.case', 'tasks', 'active'));
      expect(result!.taskMdPath).toContain('cli-abc-fix-test.md');
    });

    it('returns null when no task matches', async () => {
      const task = makeTaskJson();
      await writeRepoTask('cli-abc-fix-test', task);

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '9999', repoDir);
      expect(result).toBeNull();
    });

    it('matches by all three criteria: repo + issueType + issue', async () => {
      // Same issue number but different repo
      await writeRepoTask('other-abc', makeTaskJson({ id: 'other-abc', repo: 'other-repo' }));
      // Same repo + issue but different issueType
      await writeRepoTask('cli-linear', makeTaskJson({ id: 'cli-linear', issueType: 'linear' }));
      // Correct match
      await writeRepoTask('cli-correct', makeTaskJson({ id: 'cli-correct' }));

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523', repoDir);

      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe('cli-correct');
    });

    it('returns correct entry phase for implementing task with completed implementer', async () => {
      const task = makeTaskJson({
        status: 'implementing',
        agents: {
          implementer: { started: '2026-03-14T00:00:00Z', completed: '2026-03-14T00:01:00Z', status: 'completed' },
        },
      });
      await writeRepoTask('cli-abc-fix-test', task);

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523', repoDir);

      expect(result).not.toBeNull();
      expect(result!.entryPhase).toBe('verify');
    });

    it('returns complete phase for pr-opened task', async () => {
      const task = makeTaskJson({ status: 'pr-opened', prUrl: 'https://github.com/org/repo/pull/42' });
      await writeRepoTask('cli-abc-fix-test', task);

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523', repoDir);

      expect(result).not.toBeNull();
      expect(result!.entryPhase).toBe('complete');
    });

    it('returns null when no active task directory exists', async () => {
      await rm(join(repoDir, '.case/tasks'), { recursive: true, force: true });

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523', repoDir);
      expect(result).toBeNull();
    });

    it('skips unparseable JSON files', async () => {
      await Bun.write(join(repoDir, '.case/tasks/active/bad.task.json'), 'not json{{{');
      await writeRepoTask('cli-good', makeTaskJson({ id: 'cli-good' }));

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523', repoDir);
      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe('cli-good');
    });

    it('falls back to legacy tasks/active when repo-local state is absent', async () => {
      await rm(join(repoDir, '.case/tasks'), { recursive: true, force: true });
      await writeLegacyTask('cli-legacy', makeTaskJson({ id: 'cli-legacy' }));

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523', repoDir);

      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe('cli-legacy');
      expect(result!.taskJsonPath).toContain(join('tasks', 'active'));
    });
  });

  describe('findTaskByMarker', () => {
    it('returns task when marker points to valid task', async () => {
      const task = makeTaskJson();
      await writeRepoTask('cli-abc-fix-test', task);
      await Bun.write(join(repoDir, '.case', 'active'), 'cli-abc-fix-test\n');

      const result = await findTaskByMarker(tempDir, repoDir);

      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe('cli-abc-fix-test');
      expect(result!.entryPhase).toBe('implement');
    });

    it('returns null when no marker exists', async () => {
      const result = await findTaskByMarker(tempDir, repoDir);
      expect(result).toBeNull();
    });

    it('cleans up active marker when task file is missing', async () => {
      await Bun.write(join(repoDir, '.case', 'active'), 'nonexistent-task-id\n');
      await Bun.write(join(repoDir, '.case', 'learnings.md'), 'keep me\n');

      const result = await findTaskByMarker(tempDir, repoDir);

      expect(result).toBeNull();
      const markerExists = await Bun.file(join(repoDir, '.case', 'active')).exists();
      expect(markerExists).toBe(false);
      expect(await Bun.file(join(repoDir, '.case', 'learnings.md')).exists()).toBe(true);
    });

    it('cleans up stale marker (>24h)', async () => {
      const task = makeTaskJson();
      await writeRepoTask('cli-abc-fix-test', task);
      const markerPath = join(repoDir, '.case', 'active');
      await Bun.write(markerPath, 'cli-abc-fix-test\n');

      // Set mtime to 25 hours ago
      const pastTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await utimes(markerPath, pastTime, pastTime);

      const result = await findTaskByMarker(tempDir, repoDir);

      expect(result).toBeNull();
      const markerExists = await Bun.file(markerPath).exists();
      expect(markerExists).toBe(false);
    });

    it('cleans up marker with empty content', async () => {
      await Bun.write(join(repoDir, '.case', 'active'), '  \n');

      const result = await findTaskByMarker(tempDir, repoDir);

      expect(result).toBeNull();
      const markerExists = await Bun.file(join(repoDir, '.case', 'active')).exists();
      expect(markerExists).toBe(false);
    });

    it('returns correct entry phase for verifying task', async () => {
      const task = makeTaskJson({
        status: 'verifying',
        agents: {
          verifier: { started: '2026-03-14T00:00:00Z', completed: null, status: 'running' },
        },
      });
      await writeRepoTask('cli-abc-fix-test', task);
      await Bun.write(join(repoDir, '.case', 'active'), 'cli-abc-fix-test\n');

      const result = await findTaskByMarker(tempDir, repoDir);

      expect(result).not.toBeNull();
      expect(result!.entryPhase).toBe('verify');
    });
  });
});
