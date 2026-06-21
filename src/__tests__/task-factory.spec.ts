import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTask } from '../entry/task-factory.js';
import { decodeState, extractSpec, tdCurrent, tdShow } from '../state/td-client.js';
import type { TaskCreateRequest } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

describe('createTask', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = join(process.env.TMPDIR ?? '/tmp', `case-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a focused td issue with the embedded task state', async () => {
    const request: TaskCreateRequest = {
      repo: 'cli',
      title: 'Fix broken test',
      description: 'The login test is failing intermittently.',
      trigger: { type: 'manual', description: 'Created manually' },
      evidenceExpectations: 'Full test suite passes. The flaky login test passes 10 consecutive runs.',
    };

    const result = await createTask(tempDir, request, { repoPath: tempDir });

    expect(result.taskId).toContain('cli-');
    expect(result.tdId).toMatch(/^td-/);

    const issue = await tdShow(tempDir, result.tdId);
    expect(issue).not.toBeNull();

    const taskJson = decodeState(issue!.description);
    expect(taskJson).not.toBeNull();
    expect(taskJson!.id).toBe(result.taskId);
    expect(taskJson!.repo).toBe('cli');
    expect(taskJson!.status).toBe('active');
    expect(taskJson!.tested).toBe(false);
    expect(taskJson!.tdId).toBe(result.tdId);

    const spec = extractSpec(issue!.description);
    expect(spec).toContain('Fix broken test');
    expect(spec).toContain('The login test');
    expect(spec).toContain('Repo:** cli');
    expect(spec).toContain('## Evidence Expectations');
    expect(spec).toContain('flaky login test passes 10 consecutive runs');

    // The created task is focused (replaces the old .case/active marker).
    expect(await tdCurrent(tempDir)).toBe(result.tdId);
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
      evidenceExpectations: 'Lint passes cleanly. No regressions in existing tests.',
    };

    const result = await createTask(tempDir, request, { repoPath: tempDir });
    const issue = await tdShow(tempDir, result.tdId);
    const taskJson = decodeState(issue!.description);

    expect(taskJson!.issueType).toBe('github');
    expect(taskJson!.issue).toBe('https://github.com/workos/authkit-ssr/issues/42');
    expect(taskJson!.mode).toBe('unattended');

    const spec = extractSpec(issue!.description);
    expect(spec).toContain('webhook');
    expect(spec).toContain('https://github.com/workos/authkit-ssr/issues/42');
  });

  it('includes check fields when provided', async () => {
    const request: TaskCreateRequest = {
      repo: 'cli',
      title: 'Fix the broken unit test',
      description: 'Test is broken.',
      trigger: { type: 'manual', description: 'test' },
      checkCommand: 'vitest run --reporter=json',
      checkBaseline: 10,
      checkTarget: 12,
      evidenceExpectations: 'Test count increases from 10 to 12.',
    };

    const result = await createTask(tempDir, request, { repoPath: tempDir });
    const issue = await tdShow(tempDir, result.tdId);
    const taskJson = decodeState(issue!.description);

    expect(taskJson!.checkCommand).toBe('vitest run --reporter=json');
    expect(taskJson!.checkBaseline).toBe(10);
    expect(taskJson!.checkTarget).toBe(12);
  });
});
