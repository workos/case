import { describe, it, expect, beforeEach } from 'bun:test';
import { createTask } from '../entry/task-factory.js';
import type { TaskCreateRequest } from '../types.js';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('createTask', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `case-test-${Date.now()}`);
    await mkdir(join(tempDir, 'tasks/active'), { recursive: true });
  });

  it('creates task.json and task.md files', async () => {
    const request: TaskCreateRequest = {
      repo: 'cli',
      title: 'Fix broken test',
      description: 'The login test is failing intermittently.',
      trigger: { type: 'manual', description: 'Created manually' },
    };

    const result = await createTask(tempDir, request);

    expect(result.taskId).toContain('cli-');
    expect(result.taskJsonPath).toContain('.task.json');
    expect(result.taskMdPath).toContain('.md');

    const taskJson = JSON.parse(await readFile(result.taskJsonPath, 'utf-8'));
    expect(taskJson.id).toBe(result.taskId);
    expect(taskJson.repo).toBe('cli');
    expect(taskJson.status).toBe('active');
    expect(taskJson.tested).toBe(false);

    const taskMd = await readFile(result.taskMdPath, 'utf-8');
    expect(taskMd).toContain('Fix broken test');
    expect(taskMd).toContain('The login test');
    expect(taskMd).toContain('Repo:** cli');

    await rm(tempDir, { recursive: true, force: true });
  });

  it('includes issue and trigger info', async () => {
    const request: TaskCreateRequest = {
      repo: 'authkit-session',
      title: 'Fix CI failure: lint',
      description: 'Lint workflow failed.',
      issueType: 'github',
      issue: 'https://github.com/workos/authkit-ssr/issues/42',
      mode: 'unattended',
      trigger: { type: 'webhook', event: 'workflow_run', deliveryId: 'abc-123' },
    };

    const result = await createTask(tempDir, request);
    const taskJson = JSON.parse(await readFile(result.taskJsonPath, 'utf-8'));

    expect(taskJson.issueType).toBe('github');
    expect(taskJson.issue).toBe('https://github.com/workos/authkit-ssr/issues/42');
    expect(taskJson.mode).toBe('unattended');

    const taskMd = await readFile(result.taskMdPath, 'utf-8');
    expect(taskMd).toContain('webhook');

    await rm(tempDir, { recursive: true, force: true });
  });

  it('includes check fields when provided', async () => {
    const request: TaskCreateRequest = {
      repo: 'cli',
      title: 'Fix test',
      description: 'Test is broken.',
      trigger: { type: 'manual', description: 'test' },
      checkCommand: 'vitest run --reporter=json',
      checkBaseline: 10,
      checkTarget: 12,
    };

    const result = await createTask(tempDir, request);
    const taskJson = JSON.parse(await readFile(result.taskJsonPath, 'utf-8'));

    expect(taskJson.checkCommand).toBe('vitest run --reporter=json');
    expect(taskJson.checkBaseline).toBe(10);
    expect(taskJson.checkTarget).toBe(12);

    await rm(tempDir, { recursive: true, force: true });
  });
});
