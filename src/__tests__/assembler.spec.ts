import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { assemblePrompt } from '../context/assembler.js';
import type { AgentResult, PipelineConfig, TaskJson } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Use real temp files instead of mocking node:fs/promises
// (avoids mock.module conflicts with other test files)
const tempCaseRoot = join(process.env.TMPDIR ?? '/tmp', `case-assembler-test-${Date.now()}`);

async function setupTemplates() {
  const agentsDir = join(tempCaseRoot, 'agents');
  await mkdir(agentsDir, { recursive: true });
  await Bun.write(join(agentsDir, 'implementer.md'), '# Implementer Template');
  await Bun.write(join(agentsDir, 'verifier.md'), '# Verifier Template');
  await Bun.write(join(agentsDir, 'reviewer.md'), '# Reviewer Template');
  await Bun.write(join(agentsDir, 'closer.md'), '# Closer Template');
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'attended',
    taskJsonPath: join(tempCaseRoot, 'tasks/active/cli-1-issue-53.task.json'),
    taskMdPath: join(tempCaseRoot, 'tasks/active/cli-1-issue-53.md'),
    repoPath: '/repos/cli',
    repoName: 'cli',
    caseRoot: tempCaseRoot,
    maxRetries: 1,
    dryRun: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskJson> = {}): TaskJson {
  return {
    id: 'cli-1-issue-53',
    status: 'active',
    created: '2026-03-14T00:00:00Z',
    repo: 'cli',
    issue: '53',
    issueType: 'github',
    agents: {},
    tested: false,
    manualTested: false,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

const emptyRepoContext = {
  sessionJson: {},
  learnings: '',
  recentCommits: '',
  goldenPrinciples: '',
  workingMemory: null,
};

describe('assemblePrompt', () => {
  beforeEach(async () => {
    await setupTemplates();
  });

  afterAll(async () => {
    await rm(tempCaseRoot, { recursive: true, force: true });
  });

  it('implementer context includes learnings and working memory', async () => {
    const repoContext = {
      ...emptyRepoContext,
      learnings: '- **2026-03-14** — `src/auth.ts`: use sealed cookies\n',
      workingMemory: '## Current State\n- Phase: implementing\n',
    };

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), repoContext, new Map());

    expect(prompt).toContain('# Implementer Template');
    expect(prompt).toContain('## Task Context');
    expect(prompt).toContain('use sealed cookies');
    expect(prompt).toContain('Working Memory');
    expect(prompt).toContain('Phase: implementing');
  });

  it('implementer context includes check command fields', async () => {
    const task = makeTask({
      checkCommand: 'grep -c TODO src/',
      checkBaseline: 5,
      checkTarget: 0,
      fastTestCommand: 'pnpm vitest --related',
    });

    const prompt = await assemblePrompt('implementer', makeConfig(), task, emptyRepoContext, new Map());

    expect(prompt).toContain('Check command');
    expect(prompt).toContain('grep -c TODO src/');
    expect(prompt).toContain('Check baseline');
    expect(prompt).toContain('5');
    expect(prompt).toContain('Check target');
    expect(prompt).toContain('0');
    expect(prompt).toContain('Fast test command');
  });

  it('verifier context is minimal — no learnings or working memory', async () => {
    const repoContext = {
      ...emptyRepoContext,
      learnings: 'should not appear',
      workingMemory: 'should not appear',
    };

    const prompt = await assemblePrompt('verifier', makeConfig(), makeTask(), repoContext, new Map());

    expect(prompt).toContain('# Verifier Template');
    expect(prompt).toContain('Task file');
    expect(prompt).not.toContain('should not appear');
    expect(prompt).not.toContain('Working Memory');
  });

  it('reviewer context does NOT include implementation details', async () => {
    const repoContext = {
      ...emptyRepoContext,
      learnings: 'implementation detail',
      workingMemory: 'implementation detail',
    };

    const prompt = await assemblePrompt('reviewer', makeConfig(), makeTask(), repoContext, new Map());

    expect(prompt).toContain('# Reviewer Template');
    expect(prompt).not.toContain('implementation detail');
  });

  it('closer context includes verifier + reviewer AGENT_RESULT', async () => {
    const verifierResult: AgentResult = {
      status: 'completed',
      summary: 'Verified fix works',
      artifacts: {
        commit: null,
        filesChanged: [],
        testsPassed: null,
        screenshotUrls: ['![after](https://example.com/after.png)'],
        evidenceMarkers: ['tested', 'manual-tested'],
        prUrl: null,
        prNumber: null,
      },
      error: null,
    };

    const reviewerResult: AgentResult = {
      status: 'completed',
      summary: '0 critical, 1 warning',
      artifacts: {
        commit: null,
        filesChanged: [],
        testsPassed: null,
        screenshotUrls: [],
        evidenceMarkers: ['reviewed'],
        prUrl: null,
        prNumber: null,
      },
      findings: { critical: 0, warnings: 1, info: 0, details: [] },
      error: null,
    };

    const results = new Map<string, AgentResult>([
      ['verifier', verifierResult],
      ['reviewer', reviewerResult],
    ]) as Map<any, any>;

    const prompt = await assemblePrompt('closer', makeConfig(), makeTask(), emptyRepoContext, results);

    expect(prompt).toContain('# Closer Template');
    expect(prompt).toContain('Verifier AGENT_RESULT');
    expect(prompt).toContain('Verified fix works');
    expect(prompt).toContain('Reviewer AGENT_RESULT');
    expect(prompt).toContain('0 critical, 1 warning');
  });

  it('missing learnings file results in empty string (not error)', async () => {
    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    expect(prompt).toContain('# Implementer Template');
    expect(prompt).not.toContain('Repo Learnings');
  });

  it('revision context prepended to implementer prompt', async () => {
    const revision = {
      source: 'verifier' as const,
      failedCategories: [{ category: 'edge-case-checked', verdict: 'fail' as const, detail: 'Missing null check' }],
      summary: 'Verifier found 1 issue(s): edge-case-checked',
      suggestedFocus: ['Missing null check'],
      cycle: 1,
    };

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map(), revision);

    expect(prompt).toContain('REVISION CONTEXT');
    expect(prompt).toContain('verifier');
    expect(prompt).toContain('edge-case-checked');
    expect(prompt).toContain('Missing null check');
    expect(prompt).toContain('Do NOT redo the entire implementation');
    // Revision context comes BEFORE the template
    const revisionIdx = prompt.indexOf('REVISION CONTEXT');
    const templateIdx = prompt.indexOf('# Implementer Template');
    expect(revisionIdx).toBeLessThan(templateIdx);
  });

  it('no revision context when revision param is undefined', async () => {
    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    expect(prompt).not.toContain('REVISION CONTEXT');
  });

  it('revision context NOT applied to non-implementer roles', async () => {
    const revision = {
      source: 'verifier' as const,
      failedCategories: [{ category: 'edge-case-checked', verdict: 'fail' as const, detail: 'Missing null check' }],
      summary: 'test',
      suggestedFocus: ['test'],
      cycle: 1,
    };

    const prompt = await assemblePrompt('verifier', makeConfig(), makeTask(), emptyRepoContext, new Map(), revision);

    expect(prompt).toContain('# Verifier Template');
    expect(prompt).not.toContain('REVISION CONTEXT');
  });
});
