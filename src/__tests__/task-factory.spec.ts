import { describe, it, expect, beforeEach } from 'bun:test';
import { createTask } from '../entry/task-factory.js';
import type { TaskCreateRequest } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

describe('createTask', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(process.env.TMPDIR ?? '/tmp', `case-test-${Date.now()}`);
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

    const taskJson = JSON.parse(await Bun.file(result.taskJsonPath).text());
    expect(taskJson.id).toBe(result.taskId);
    expect(taskJson.repo).toBe('cli');
    expect(taskJson.status).toBe('active');
    expect(taskJson.tested).toBe(false);

    const taskMd = await Bun.file(result.taskMdPath).text();
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
    const taskJson = JSON.parse(await Bun.file(result.taskJsonPath).text());

    expect(taskJson.issueType).toBe('github');
    expect(taskJson.issue).toBe('https://github.com/workos/authkit-ssr/issues/42');
    expect(taskJson.mode).toBe('unattended');

    const taskMd = await Bun.file(result.taskMdPath).text();
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
    const taskJson = JSON.parse(await Bun.file(result.taskJsonPath).text());

    expect(taskJson.checkCommand).toBe('vitest run --reporter=json');
    expect(taskJson.checkBaseline).toBe(10);
    expect(taskJson.checkTarget).toBe(12);

    await rm(tempDir, { recursive: true, force: true });
  });
});
