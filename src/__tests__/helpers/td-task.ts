/**
 * Test helper: create a `td`-backed Case task in a throwaway repo.
 *
 * Replaces the old pattern of hand-writing `.case/tasks/active/<id>.task.json`
 * fixtures. Spins up a real `td` database (the `td` binary must be on PATH) in
 * a temp dir, creates the task via the production {@link createTask}, then
 * applies any state overrides through the production {@link TaskStore} so tests
 * exercise the same read/write path as the pipeline.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask } from '../../entry/task-factory.js';
import { TaskStore } from '../../state/task-store.js';
import type { TaskCreateRequest, TaskJson } from '../../types.js';

export interface TdTaskFixture {
  repoPath: string;
  tdId: string;
  taskId: string;
  store: TaskStore;
}

export interface CreateTdTaskOptions {
  /** Existing repo dir (with or without a td db). A temp dir is made when omitted. */
  repoPath?: string;
  /** Overrides applied to the TaskCreateRequest before creation. */
  request?: Partial<TaskCreateRequest>;
  /** State overrides written back after creation (status, agents, prUrl, etc.). */
  overrides?: Partial<TaskJson>;
}

export function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'case-td-'));
}

export async function createTdTask(opts: CreateTdTaskOptions = {}): Promise<TdTaskFixture> {
  const repoPath = opts.repoPath ?? makeTempRepo();

  const request: TaskCreateRequest = {
    repo: 'cli',
    title: 'Fix the flaky login test',
    description: 'The login test fails intermittently.',
    trigger: { type: 'cli', user: 'test' },
    evidenceExpectations: 'Full test suite passes.',
    ...opts.request,
  };

  const { taskId, tdId } = await createTask(repoPath, request, { repoPath });
  const store = new TaskStore(repoPath, tdId);

  if (opts.overrides) {
    await store.writeFromProjection(opts.overrides);
  }

  return { repoPath, tdId, taskId, store };
}
