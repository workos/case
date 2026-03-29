import { describe, it, expect, mock, beforeEach, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mockSpawnAgent, mockRunScript } from './mocks.js';

/**
 * From-ideation module tests.
 *
 * Tests contract loading, spec discovery, execution flow, re-entry,
 * error handling, and the tool wrapper.
 *
 * Uses real filesystem for ideation artifacts and task files.
 * spawnAgent and runScript are mocked (via the global preload).
 * runPipeline is mocked here — pipeline has its own tests.
 */

// Mock pipeline — from-ideation delegates post-implementation to runPipeline
const mockRunPipeline = mock();
const mockBuildPipelineConfig = mock();
mock.module('../pipeline.js', () => ({ runPipeline: mockRunPipeline }));
mock.module('../config.js', () => ({
  buildPipelineConfig: mockBuildPipelineConfig,
  loadProjects: mock(() => Promise.resolve([])),
  resolveRepoPath: mock((_: string, p: string) => p),
}));

const { loadContract, discoverSpecs, executeFromIdeation } = await import('../agent/from-ideation.js');
const { createFromIdeationTool } = await import('../agent/tools/from-ideation-tool.js');

// --- Temp directory setup ---

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'from-ideation-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// --- Helpers ---

const SAMPLE_CONTRACT = `# Contract

## Problem Statement

Users cannot execute ideation specs through the agent pipeline.

## Goals

Automate ideation-to-PR flow.

## Success Criteria

- Pipeline runs all phases
- PR is created
`;

async function createIdeationFolder(name: string, files: Record<string, string>): Promise<string> {
  const folder = resolve(tmpDir, name);
  await mkdir(folder, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(resolve(folder, filename), content);
  }
  return folder;
}

async function createCaseRoot(name: string): Promise<string> {
  const caseRoot = resolve(tmpDir, name);
  await mkdir(resolve(caseRoot, 'tasks/active'), { recursive: true });
  await mkdir(resolve(caseRoot, 'scripts'), { recursive: true });
  await mkdir(resolve(caseRoot, 'agents'), { recursive: true });
  // Create agent prompts the module needs
  await writeFile(resolve(caseRoot, 'agents/implementer.md'), '---\nname: implementer\n---\nYou are the implementer.');
  await writeFile(resolve(caseRoot, 'agents/verifier.md'), '---\nname: verifier\n---\nYou are the verifier.');
  await writeFile(resolve(caseRoot, 'agents/reviewer.md'), '---\nname: reviewer\n---\nYou are the reviewer.');
  await writeFile(resolve(caseRoot, 'agents/closer.md'), '---\nname: closer\n---\nYou are the closer.');
  return caseRoot;
}

function mockAgentResult(overrides: Record<string, unknown> = {}) {
  return {
    raw: '',
    result: {
      status: 'completed',
      summary: 'Phase completed successfully',
      artifacts: {
        commit: 'abc123',
        filesChanged: ['src/foo.ts'],
        testsPassed: true,
        screenshotUrls: [],
        evidenceMarkers: [],
        prUrl: null,
        prNumber: null,
      },
      error: null,
      ...overrides,
    },
    durationMs: 1000,
  };
}

// --- Tests ---

describe('loadContract', () => {
  it('extracts problem statement, goals, and success criteria', async () => {
    const folder = await createIdeationFolder('test-load', {
      'contract.md': SAMPLE_CONTRACT,
      'spec.md': '# Spec',
    });

    const contract = await loadContract(folder);

    expect(contract.problemStatement).toContain('Users cannot execute');
    expect(contract.goals).toContain('Automate ideation');
    expect(contract.successCriteria).toContain('Pipeline runs all phases');
    expect(contract.specFiles).toHaveLength(1);
  });

  it('throws when contract.md is missing', async () => {
    const folder = await createIdeationFolder('test-no-contract', {
      'spec.md': '# Spec',
    });

    await expect(loadContract(folder)).rejects.toThrow('No contract.md found');
  });
});

describe('discoverSpecs', () => {
  it('finds and sorts multi-phase spec files', async () => {
    const folder = await createIdeationFolder('test-multi', {
      'contract.md': '# Contract',
      'spec-phase-3.md': '# Phase 3',
      'spec-phase-1.md': '# Phase 1',
      'spec-phase-2.md': '# Phase 2',
    });

    const specs = await discoverSpecs(folder);

    expect(specs).toHaveLength(3);
    expect(specs[0]).toContain('spec-phase-1.md');
    expect(specs[1]).toContain('spec-phase-2.md');
    expect(specs[2]).toContain('spec-phase-3.md');
  });

  it('handles single spec (no phase number)', async () => {
    const folder = await createIdeationFolder('test-single', {
      'contract.md': '# Contract',
      'spec.md': '# Spec',
    });

    const specs = await discoverSpecs(folder);

    expect(specs).toHaveLength(1);
    expect(specs[0]).toContain('spec.md');
  });

  it('throws when no spec files found', async () => {
    const folder = await createIdeationFolder('test-empty', {
      'contract.md': '# Contract',
      'README.md': '# Readme',
    });

    await expect(discoverSpecs(folder)).rejects.toThrow('No spec files found');
  });

  it('throws when directory does not exist', async () => {
    await expect(discoverSpecs(resolve(tmpDir, 'nonexistent'))).rejects.toThrow('No spec files found');
  });

  it('excludes spec-template files from execution specs', async () => {
    const folder = await createIdeationFolder('test-tpl-exclusion', {
      'contract.md': '# Contract',
      'spec-phase-1.md': '# Phase 1',
      'spec-phase-2.md': '# Phase 2',
      'spec-template-component.md': '# Template',
    });

    const specs = await discoverSpecs(folder);

    expect(specs).toHaveLength(2);
    expect(specs.every((s) => !s.includes('spec-template'))).toBe(true);
  });
});

describe('executeFromIdeation', () => {
  let ideationFolder: string;
  let caseRoot: string;

  beforeEach(async () => {
    mockSpawnAgent.mockReset();
    mockRunScript.mockReset();
    mockRunPipeline.mockReset();
    mockBuildPipelineConfig.mockReset();

    // Create fresh dirs for each test
    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    ideationFolder = await createIdeationFolder(`exec-${testId}`, {
      'contract.md': SAMPLE_CONTRACT,
      'spec.md': '# Spec\n\nImplement the feature.',
    });
    caseRoot = await createCaseRoot(`case-${testId}`);

    // runScript: git rev-parse (exit 1 = no branch), git checkout -b (exit 0), baseline (exit 0)
    mockRunScript
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'OK', stderr: '', exitCode: 0 });

    // Pipeline mock: simulate writing PR URL to task JSON (like a real pipeline would)
    mockBuildPipelineConfig.mockImplementation(async (opts: { taskJsonPath: string }) => ({
      taskJsonPath: opts.taskJsonPath,
      mode: 'attended',
    }));
    mockRunPipeline.mockImplementation(async (config: { taskJsonPath: string }) => {
      const raw = await readFile(config.taskJsonPath, 'utf-8');
      const task = JSON.parse(raw);
      task.prUrl = 'https://github.com/org/repo/pull/1';
      task.status = 'pr-opened';
      await writeFile(config.taskJsonPath, JSON.stringify(task, null, 2) + '\n');
    });
  });

  it('creates task, spawns implementer per phase, then delegates to pipeline', async () => {
    mockSpawnAgent.mockResolvedValueOnce(mockAgentResult()); // implementer

    const result = await executeFromIdeation({
      ideationFolder,
      caseRoot,
      repoName: 'cli',
      repoPath: '/repos/cli',
    });

    // Only implementer is spawned directly — pipeline handles verify/review/close
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].status).toBe('completed');
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
  });

  it('spawns implementer once per phase then delegates to pipeline', async () => {
    // Create a multi-phase ideation folder
    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const multiFolder = await createIdeationFolder(`multi-${testId}`, {
      'contract.md': SAMPLE_CONTRACT,
      'spec-phase-1.md': '# Phase 1\n\nSet up types.',
      'spec-phase-2.md': '# Phase 2\n\nAdd the module.',
    });

    // 2 implementer calls only — pipeline handles the rest
    mockSpawnAgent
      .mockResolvedValueOnce(mockAgentResult({ summary: 'Phase 1 done' }))
      .mockResolvedValueOnce(mockAgentResult({ summary: 'Phase 2 done' }));

    const result = await executeFromIdeation({
      ideationFolder: multiFolder,
      caseRoot,
      repoName: 'cli',
      repoPath: '/repos/cli',
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].summary).toBe('Phase 1 done');
    expect(result.phases[1].summary).toBe('Phase 2 done');
  });

  it('returns error when contract is missing', async () => {
    const emptyFolder = await createIdeationFolder(`no-contract-${Date.now().toString(36)}`, {
      'README.md': '# Readme',
    });

    const result = await executeFromIdeation({
      ideationFolder: emptyFolder,
      caseRoot,
      repoName: 'cli',
      repoPath: '/repos/cli',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No contract.md found');
  });

  it('returns error when baseline fails', async () => {
    mockRunScript.mockReset();
    mockRunScript
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'lint failed', stderr: '', exitCode: 1 });

    const result = await executeFromIdeation({
      ideationFolder,
      caseRoot,
      repoName: 'cli',
      repoPath: '/repos/cli',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Baseline failed');
  });

  it('returns structured error when implementer fails', async () => {
    mockSpawnAgent.mockResolvedValueOnce(
      mockAgentResult({
        status: 'failed',
        summary: 'Build errors',
        error: 'TypeScript compilation failed',
      }),
    );

    const result = await executeFromIdeation({
      ideationFolder,
      caseRoot,
      repoName: 'cli',
      repoPath: '/repos/cli',
    });

    expect(result.success).toBe(false);
    expect(result.phases[0].status).toBe('failed');
    expect(result.error).toContain('Phase 1 failed');
  });

  it('fires progress callback for each stage', async () => {
    mockSpawnAgent.mockResolvedValue(mockAgentResult());

    const progress: string[] = [];
    await executeFromIdeation({
      ideationFolder,
      caseRoot,
      repoName: 'cli',
      repoPath: '/repos/cli',
      onProgress: (msg) => progress.push(msg),
    });

    expect(progress).toContain('Loading contract...');
    expect(progress).toContain('Creating task...');
    expect(progress.some((p) => p.includes('Executing phase'))).toBe(true);
    expect(progress.some((p) => p.includes('Running pipeline'))).toBe(true);
  });

  it('passes approve option through to pipeline config', async () => {
    mockSpawnAgent.mockResolvedValueOnce(mockAgentResult());

    await executeFromIdeation({
      ideationFolder,
      caseRoot,
      repoName: 'cli',
      repoPath: '/repos/cli',
      approve: true,
    });

    expect(mockBuildPipelineConfig).toHaveBeenCalledWith(
      expect.objectContaining({ approve: true }),
    );
  });

  it('returns existing PR URL for re-entry when PR already exists', async () => {
    const contractPath = resolve(ideationFolder, 'contract.md');
    await writeFile(
      resolve(caseRoot, 'tasks/active/cli-existing.task.json'),
      JSON.stringify({
        id: 'cli-existing',
        status: 'pr-opened',
        contractPath,
        prUrl: 'https://github.com/org/repo/pull/42',
      }),
    );

    const result = await executeFromIdeation({
      ideationFolder,
      caseRoot,
      repoName: 'cli',
      repoPath: '/repos/cli',
    });

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

describe('createFromIdeationTool', () => {
  it('has correct tool metadata', () => {
    const tool = createFromIdeationTool('/case');

    expect(tool.name).toBe('run_from_ideation');
    expect(tool.label).toBe('From Ideation');
    expect(tool.description).toContain('ideation');
    expect(tool.promptSnippet).toBeDefined();
  });
});
