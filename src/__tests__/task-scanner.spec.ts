import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { findTaskByIssue, findTaskByMarker } from '../entry/task-scanner.js';
import type { TaskJson } from '../types.js';
import { mkdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';

let tempDir: string;

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

async function writeTask(taskId: string, task: TaskJson): Promise<string> {
  const taskJsonPath = join(tempDir, 'tasks/active', `${taskId}.task.json`);
  await Bun.write(taskJsonPath, JSON.stringify(task, null, 2));
  return taskJsonPath;
}

describe('task-scanner', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = join(process.env.TMPDIR ?? '/tmp', `case-scanner-test-${Date.now()}`);
    await mkdir(join(tempDir, 'tasks/active'), { recursive: true });
    // Phase 3: scanner consults dataDir first. Point it at a sibling temp dir so
    // legacy fallback (caseRoot=tempDir/tasks/active) is exercised.
    process.env.CASE_DATA_DIR = join(tempDir, '.case-data-empty');
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('findTaskByIssue', () => {
    it('returns matching task with correct entry phase', async () => {
      const task = makeTaskJson();
      await writeTask('cli-abc-fix-test', task);

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523');

      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe('cli-abc-fix-test');
      expect(result!.taskJson.issue).toBe('1523');
      expect(result!.entryPhase).toBe('implement');
      expect(result!.taskJsonPath).toContain('cli-abc-fix-test.task.json');
      expect(result!.taskMdPath).toContain('cli-abc-fix-test.md');
    });

    it('returns null when no task matches', async () => {
      const task = makeTaskJson();
      await writeTask('cli-abc-fix-test', task);

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '9999');
      expect(result).toBeNull();
    });

    it('matches by all three criteria: repo + issueType + issue', async () => {
      // Same issue number but different repo
      await writeTask('other-abc', makeTaskJson({ id: 'other-abc', repo: 'other-repo' }));
      // Same repo + issue but different issueType
      await writeTask('cli-linear', makeTaskJson({ id: 'cli-linear', issueType: 'linear' }));
      // Correct match
      await writeTask('cli-correct', makeTaskJson({ id: 'cli-correct' }));

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523');

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
      await writeTask('cli-abc-fix-test', task);

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523');

      expect(result).not.toBeNull();
      expect(result!.entryPhase).toBe('verify');
    });

    it('returns complete phase for pr-opened task', async () => {
      const task = makeTaskJson({ status: 'pr-opened', prUrl: 'https://github.com/org/repo/pull/42' });
      await writeTask('cli-abc-fix-test', task);

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523');

      expect(result).not.toBeNull();
      expect(result!.entryPhase).toBe('complete');
    });

    it('returns null when tasks/active directory does not exist', async () => {
      await rm(join(tempDir, 'tasks'), { recursive: true, force: true });

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523');
      expect(result).toBeNull();
    });

    it('skips unparseable JSON files', async () => {
      await Bun.write(join(tempDir, 'tasks/active/bad.task.json'), 'not json{{{');
      await writeTask('cli-good', makeTaskJson({ id: 'cli-good' }));

      const result = await findTaskByIssue(tempDir, 'cli', 'github', '1523');
      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe('cli-good');
    });
  });

  describe('findTaskByMarker', () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = join(tempDir, 'repo');
      await mkdir(join(repoDir, '.case'), { recursive: true });
    });

    it('returns task when marker points to valid task', async () => {
      const task = makeTaskJson();
      await writeTask('cli-abc-fix-test', task);
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

    it('cleans up .case/ dir when task file is missing', async () => {
      await Bun.write(join(repoDir, '.case', 'active'), 'nonexistent-task-id\n');

      const result = await findTaskByMarker(tempDir, repoDir);

      expect(result).toBeNull();
      // Entire .case/ directory should be cleaned up
      const caseDirExists = await Bun.file(join(repoDir, '.case', 'active')).exists();
      expect(caseDirExists).toBe(false);
    });

    it('cleans up stale marker (>24h)', async () => {
      const task = makeTaskJson();
      await writeTask('cli-abc-fix-test', task);
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
      const caseDirExists = await Bun.file(join(repoDir, '.case', 'active')).exists();
      expect(caseDirExists).toBe(false);
    });

    it('returns ideation task entry phase as implement', async () => {
      const task = makeTaskJson({ issueType: 'ideation' });
      await writeTask('cli-abc-fix-test', task);
      await Bun.write(join(repoDir, '.case', 'active'), 'cli-abc-fix-test\n');

      const result = await findTaskByMarker(tempDir, repoDir);

      // Scanner returns the match; the orchestrator decides what to do with ideation tasks
      expect(result).not.toBeNull();
      expect(result!.taskJson.issueType).toBe('ideation');
    });

    it('returns correct entry phase for verifying task', async () => {
      const task = makeTaskJson({
        status: 'verifying',
        agents: {
          verifier: { started: '2026-03-14T00:00:00Z', completed: null, status: 'running' },
        },
      });
      await writeTask('cli-abc-fix-test', task);
      await Bun.write(join(repoDir, '.case', 'active'), 'cli-abc-fix-test\n');

      const result = await findTaskByMarker(tempDir, repoDir);

      expect(result).not.toBeNull();
      expect(result!.entryPhase).toBe('verify');
    });
  });
});
