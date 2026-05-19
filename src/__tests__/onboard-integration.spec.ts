/**
 * End-to-end integration tests for `ca onboard --interview`.
 *
 * Validates that interview findings produced by the interviewer agent actually
 * reach the runtime pipeline:
 *
 *   - the synthesized {@link ProjectEntry} carries the interview's evidence
 *     strategy and verification notes through to `projects.json`,
 *   - `--re-interview` updates an existing entry in-place,
 *   - `verificationNotes` on the project entry appears in the verifier
 *     prompt assembled by {@link assemblePrompt},
 *   - the interview-seeded `.case/learnings.md` lives at the same path the
 *     implementer's repo-context prefetch reads.
 *
 * These tests stay at the synthesis + writer + assembler boundary — they do
 * not spawn agents or call into the LLM.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { synthesizeProjectEntry } from '../interview/findings.js';
import { writeClaudeLocal, writeLearnings, writeProjectsEntry } from '../interview/writers.js';
import { assemblePrompt } from '../context/assembler.js';
import { resolveRepoClaudeLocal, resolveRepoLearnings } from '../paths.js';
import type { DetectedRepoForSynthesis } from '../interview/findings.js';
import type { InterviewFindings, PipelineConfig, ProjectEntry, TaskJson } from '../types.js';

const tempCaseRoot = join(
  process.env.TMPDIR ?? '/tmp',
  `case-onboard-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function captureStream(stream: NodeJS.WriteStream): { restore: () => void } {
  const original = stream.write.bind(stream);
  (stream as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (): boolean => true;
  return {
    restore: () => {
      (stream as unknown as { write: typeof original }).write = original;
    },
  };
}

function makeFindings(overrides: Partial<InterviewFindings> = {}): InterviewFindings {
  return {
    evidenceStrategy: 'test-output',
    evidenceRationale: 'SDK — verifier reads test runner output.',
    verificationNotes: 'Set WORKOS_API_KEY before running tests.',
    description: 'AuthKit SDK for Next.js apps',
    commandOverrides: {},
    learnings: [
      { topic: 'Architecture', content: 'Cookie-based session.' },
      { topic: 'Testing', content: 'Vitest mocks under src/__mocks__/.' },
    ],
    conventions: [{ rule: 'Always run typecheck', reason: 'CI rejects type errors.' }],
    repoType: 'sdk',
    hasExampleApp: false,
    testFramework: 'vitest',
    ciProvider: 'github-actions',
    ...overrides,
  };
}

function makeDetected(overrides: Partial<DetectedRepoForSynthesis> = {}): DetectedRepoForSynthesis {
  return {
    name: 'authkit-nextjs',
    path: './authkit-nextjs',
    remote: 'git@github.com:workos/authkit-nextjs.git',
    language: 'typescript',
    packageManager: 'pnpm',
    description: 'mechanical description',
    commands: { setup: 'pnpm install', test: 'pnpm test' },
    // Mechanical heuristic guesses ui-screenshot — the interview overrides.
    evidenceStrategy: 'ui-screenshot',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'attended',
    taskJsonPath: join(tempCaseRoot, '.case/tasks/active/example.task.json'),
    taskMdPath: join(tempCaseRoot, '.case/tasks/active/example.md'),
    repoPath: tempCaseRoot,
    repoName: 'authkit-nextjs',
    packageRoot: tempCaseRoot,
    dataDir: tempCaseRoot,
    maxRetries: 1,
    dryRun: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskJson> = {}): TaskJson {
  return {
    id: 'authkit-nextjs-1',
    status: 'active',
    created: '2026-05-19T00:00:00Z',
    repo: 'authkit-nextjs',
    issue: '1',
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

let stdout: ReturnType<typeof captureStream>;
let tempDir: string;

async function setupAgentTemplates(): Promise<void> {
  const agentsDir = join(tempCaseRoot, 'agents');
  await mkdir(agentsDir, { recursive: true });
  await Bun.write(join(agentsDir, 'implementer.md'), '# Implementer Template');
  await Bun.write(join(agentsDir, 'verifier.md'), '# Verifier Template');
  await Bun.write(join(agentsDir, 'reviewer.md'), '# Reviewer Template');
  await Bun.write(join(agentsDir, 'closer.md'), '# Closer Template');
}

beforeEach(async () => {
  await setupAgentTemplates();
  tempDir = join(
    process.env.TMPDIR ?? '/tmp',
    `case-onboard-integration-case-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tempDir, { recursive: true });
  stdout = captureStream(process.stdout);
});

afterEach(async () => {
  stdout.restore();
  await rm(tempDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(tempCaseRoot, { recursive: true, force: true });
});

describe('onboard interview integration — findings produce correct pipeline config', () => {
  it('interview findings override mechanical evidence strategy in the synthesized entry', async () => {
    const findings = makeFindings({ evidenceStrategy: 'test-output' });
    const detected = makeDetected({ evidenceStrategy: 'ui-screenshot' });

    const entry = synthesizeProjectEntry(findings, detected);

    expect(entry.evidenceStrategy).toBe('test-output');
    expect(entry.evidenceStrategy).not.toBe(detected.evidenceStrategy);
    expect(entry.verificationNotes).toBe('Set WORKOS_API_KEY before running tests.');
    expect(entry.description).toBe('AuthKit SDK for Next.js apps');
  });

  it('writes the entry to projects.json with the interview-derived fields', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    await writeFile(manifestPath, JSON.stringify({ $schema: './projects.schema.json', repos: [] }, null, 2));

    const entry = synthesizeProjectEntry(makeFindings(), makeDetected());
    writeProjectsEntry(manifestPath, entry);

    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos[0].evidenceStrategy).toBe('test-output');
    expect(parsed.repos[0].verificationNotes).toBe('Set WORKOS_API_KEY before running tests.');
  });

  it('writes the interview-seeded learnings.md and CLAUDE.local.md', async () => {
    const findings = makeFindings();
    writeLearnings(tempDir, findings);
    writeClaudeLocal(tempDir, findings);

    const learningsPath = resolveRepoLearnings(tempDir);
    const claudeLocalPath = resolveRepoClaudeLocal(tempDir);

    expect(existsSync(learningsPath)).toBe(true);
    expect(existsSync(claudeLocalPath)).toBe(true);

    const learnings = readFileSync(learningsPath, 'utf-8');
    expect(learnings).toContain('## Architecture');
    expect(learnings).toContain('Cookie-based session.');

    const claudeLocal = readFileSync(claudeLocalPath, 'utf-8');
    expect(claudeLocal).toContain('Always run typecheck');
  });
});

describe('onboard interview integration — re-interview updates existing entry', () => {
  it('re-interview replaces the entry instead of appending a duplicate', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    const original: ProjectEntry = {
      name: 'authkit-nextjs',
      evidenceStrategy: 'ui-screenshot',
      path: './authkit-nextjs',
      remote: 'git@github.com:workos/authkit-nextjs.git',
      description: 'old description',
      language: 'typescript',
      packageManager: 'pnpm',
      commands: { setup: 'pnpm install', test: 'pnpm test' },
      verificationNotes: 'old notes',
    };

    await writeFile(manifestPath, JSON.stringify({ $schema: './projects.schema.json', repos: [original] }, null, 2));

    const findings = makeFindings({
      evidenceStrategy: 'test-output',
      verificationNotes: 'new notes from re-interview',
      description: 'new description',
    });
    const updated = synthesizeProjectEntry(findings, makeDetected());

    writeProjectsEntry(manifestPath, updated, original.name);

    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos[0].evidenceStrategy).toBe('test-output');
    expect(parsed.repos[0].verificationNotes).toBe('new notes from re-interview');
    expect(parsed.repos[0].description).toBe('new description');
  });

  it('preserves the existing entry name when directory basename differs', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    const original: ProjectEntry = {
      name: 'cli',
      evidenceStrategy: 'test-output',
      path: './cli/main',
      remote: 'git@github.com:workos/cli.git',
      description: 'WorkOS CLI',
      language: 'go',
      packageManager: 'go',
      commands: { test: 'go test ./...' },
    };

    await writeFile(manifestPath, JSON.stringify({ $schema: './projects.schema.json', repos: [original] }, null, 2));

    const findings = makeFindings({ description: 'updated CLI description' });
    const detected = makeDetected({ name: 'main', path: './cli/main' });
    const entry = synthesizeProjectEntry(findings, detected);
    entry.name = original.name;

    writeProjectsEntry(manifestPath, entry, original.name);

    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos[0].name).toBe('cli');
    expect(parsed.repos[0].description).toBe('updated CLI description');
  });
});

describe('onboard interview integration — verificationNotes reaches verifier prompt', () => {
  it('injects verificationNotes from the project entry into the verifier prompt', async () => {
    const project: ProjectEntry = {
      name: 'authkit-nextjs',
      evidenceStrategy: 'test-output',
      path: './authkit-nextjs',
      remote: 'git@github.com:workos/authkit-nextjs.git',
      description: 'AuthKit SDK for Next.js apps',
      language: 'typescript',
      packageManager: 'pnpm',
      commands: { setup: 'pnpm install', test: 'pnpm test' },
      verificationNotes: 'Set WORKOS_API_KEY before running tests.',
    };

    const prompt = await assemblePrompt('verifier', makeConfig({ project }), makeTask(), emptyRepoContext, new Map());

    expect(prompt).toContain('# Verifier Template');
    expect(prompt).toContain('### Verification Notes');
    expect(prompt).toContain('Set WORKOS_API_KEY before running tests.');
  });

  it('omits the Verification Notes section when the entry has no notes', async () => {
    const project: ProjectEntry = {
      name: 'authkit-nextjs',
      evidenceStrategy: 'test-output',
      path: './authkit-nextjs',
      remote: 'git@github.com:workos/authkit-nextjs.git',
      description: 'AuthKit SDK for Next.js apps',
      language: 'typescript',
      packageManager: 'pnpm',
      commands: { setup: 'pnpm install', test: 'pnpm test' },
    };

    const prompt = await assemblePrompt('verifier', makeConfig({ project }), makeTask(), emptyRepoContext, new Map());

    expect(prompt).not.toContain('### Verification Notes');
  });
});

describe('onboard interview integration — learnings path matches implementer read path', () => {
  it('writeLearnings writes to resolveRepoLearnings — the same path the implementer reads', async () => {
    const findings = makeFindings();
    writeLearnings(tempDir, findings);

    const expectedPath = resolveRepoLearnings(tempDir);
    expect(existsSync(expectedPath)).toBe(true);

    // Sanity-check the canonical layout (kept in sync with src/paths.ts).
    expect(expectedPath.endsWith('/.case/learnings.md')).toBe(true);
  });
});
