import { describe, it, expect, beforeAll } from 'bun:test';
import { findTaskByIssue, findTaskByMarker } from '../entry/task-scanner.js';
import { createTdTask, makeTempRepo } from './helpers/td-task.js';

describe('task-scanner', () => {
  describe('findTaskByIssue', () => {
    // One repo shared across the matching cases. It holds three tasks that
    // differ only by repo / issueType so we can assert the three-way match.
    let repoPath: string;
    let correctTaskId: string;

    beforeAll(async () => {
      repoPath = makeTempRepo();

      // Same issue number but different repo.
      await createTdTask({
        repoPath,
        request: { repo: 'other-repo', issue: '1523', issueType: 'github' },
      });
      // Same repo + issue but different issueType.
      await createTdTask({
        repoPath,
        request: { repo: 'cli', issue: '1523', issueType: 'linear' },
      });
      // The correct match: repo=cli, issueType=github, issue=1523.
      const correct = await createTdTask({
        repoPath,
        request: { repo: 'cli', issue: '1523', issueType: 'github' },
      });
      correctTaskId = correct.taskId;
    });

    it('returns matching task with correct entry phase', async () => {
      const result = await findTaskByIssue(repoPath, 'cli', 'github', '1523', repoPath);

      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe(correctTaskId);
      expect(result!.taskJson.issue).toBe('1523');
      expect(result!.entryPhase).toBe('implement');
      expect(result!.tdId).toMatch(/^td-/);
      expect(result!.taskJson.tdId).toBe(result!.tdId);
    });

    it('returns null when no task matches', async () => {
      const result = await findTaskByIssue(repoPath, 'cli', 'github', '9999', repoPath);
      expect(result).toBeNull();
    });

    it('matches by all three criteria: repo + issueType + issue', async () => {
      const result = await findTaskByIssue(repoPath, 'cli', 'github', '1523', repoPath);

      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe(correctTaskId);
      expect(result!.taskJson.repo).toBe('cli');
      expect(result!.taskJson.issueType).toBe('github');
    });

    it('returns null when the repo has no tasks at all', async () => {
      const emptyRepo = makeTempRepo();
      const result = await findTaskByIssue(emptyRepo, 'cli', 'github', '1523', emptyRepo);
      expect(result).toBeNull();
    });
  });

  describe('findTaskByIssue entry-phase derivation', () => {
    it('returns verify phase for implementing task with completed implementer', async () => {
      const { repoPath } = await createTdTask({
        request: { repo: 'cli', issue: '4242', issueType: 'github' },
        overrides: {
          status: 'implementing',
          agents: {
            implementer: { started: '2026-03-14T00:00:00Z', completed: '2026-03-14T00:01:00Z', status: 'completed' },
          },
        },
      });

      const result = await findTaskByIssue(repoPath, 'cli', 'github', '4242', repoPath);

      expect(result).not.toBeNull();
      expect(result!.entryPhase).toBe('verify');
    });

    it('returns complete phase for pr-opened task', async () => {
      const { repoPath } = await createTdTask({
        request: { repo: 'cli', issue: '4343', issueType: 'github' },
        overrides: { status: 'pr-opened', prUrl: 'https://github.com/org/repo/pull/42' },
      });

      const result = await findTaskByIssue(repoPath, 'cli', 'github', '4343', repoPath);

      expect(result).not.toBeNull();
      expect(result!.entryPhase).toBe('complete');
    });
  });

  describe('findTaskByMarker', () => {
    it('returns the focused task with correct entry phase', async () => {
      // createTdTask focuses the task it creates (via td focus on create).
      const { repoPath, taskId } = await createTdTask({
        request: { repo: 'cli', issue: '5151', issueType: 'github' },
      });

      const result = await findTaskByMarker(repoPath, repoPath);

      expect(result).not.toBeNull();
      expect(result!.taskJson.id).toBe(taskId);
      expect(result!.entryPhase).toBe('implement');
      expect(result!.tdId).toMatch(/^td-/);
    });

    it('returns null when nothing is focused', async () => {
      const emptyRepo = makeTempRepo();
      const result = await findTaskByMarker(emptyRepo, emptyRepo);
      expect(result).toBeNull();
    });

    it('returns correct entry phase for verifying task', async () => {
      const { repoPath } = await createTdTask({
        request: { repo: 'cli', issue: '5252', issueType: 'github' },
        overrides: {
          status: 'verifying',
          agents: {
            verifier: { started: '2026-03-14T00:00:00Z', completed: null, status: 'running' },
          },
        },
      });

      const result = await findTaskByMarker(repoPath, repoPath);

      expect(result).not.toBeNull();
      expect(result!.entryPhase).toBe('verify');
    });
  });
});
