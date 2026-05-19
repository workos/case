import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeClaudeLocal, writeLearnings, writeProjectsEntry } from '../interview/writers.js';
import type { InterviewFindings, ProjectEntry } from '../types.js';

function captureStream(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = stream.write.bind(stream);
  (stream as any).write = (chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  };
  return {
    lines,
    restore: () => {
      (stream as any).write = original;
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

function makeEntry(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    name: 'authkit-nextjs',
    evidenceStrategy: 'test-output',
    path: './authkit-nextjs',
    remote: 'git@github.com:workos/authkit-nextjs.git',
    description: 'AuthKit SDK for Next.js apps',
    language: 'typescript',
    packageManager: 'pnpm',
    commands: { setup: 'pnpm install', test: 'pnpm test' },
    verificationNotes: 'auth required',
    ...overrides,
  };
}

let tempDir: string;
let stdout: ReturnType<typeof captureStream>;

beforeEach(async () => {
  tempDir = join(
    process.env.TMPDIR ?? '/tmp',
    `case-onboard-interview-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tempDir, { recursive: true });
  stdout = captureStream(process.stdout);
});

afterEach(async () => {
  stdout.restore();
  await rm(tempDir, { recursive: true, force: true });
});

describe('writeProjectsEntry', () => {
  it('appends a new entry when name is not in projects.json', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    await writeFile(manifestPath, JSON.stringify({ $schema: './projects.schema.json', repos: [] }, null, 2));

    writeProjectsEntry(manifestPath, makeEntry());

    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos[0].name).toBe('authkit-nextjs');
    expect(parsed.repos[0].evidenceStrategy).toBe('test-output');
  });

  it('preserves $schema and pre-existing repos when appending', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          $schema: './projects.schema.json',
          repos: [
            {
              name: 'other-repo',
              evidenceStrategy: 'test-output',
              path: './other',
              remote: 'git@github.com:workos/other.git',
              description: '',
              language: 'typescript',
              packageManager: 'npm',
              commands: { setup: 'npm install', test: 'npm test' },
            },
          ],
        },
        null,
        2,
      ),
    );

    writeProjectsEntry(manifestPath, makeEntry());

    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(parsed.$schema).toBe('./projects.schema.json');
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.repos.map((r: ProjectEntry) => r.name)).toEqual(['other-repo', 'authkit-nextjs']);
  });

  it('replaces an existing entry when existingName is provided', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    const original = makeEntry({ evidenceStrategy: 'ui-screenshot', description: 'old desc' });
    await writeFile(manifestPath, JSON.stringify({ $schema: './projects.schema.json', repos: [original] }, null, 2));

    const updated = makeEntry({ evidenceStrategy: 'test-output', description: 'new desc' });
    writeProjectsEntry(manifestPath, updated, original.name);

    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos[0].evidenceStrategy).toBe('test-output');
    expect(parsed.repos[0].description).toBe('new desc');
  });

  it('throws when existingName does not match any repo', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    await writeFile(manifestPath, JSON.stringify({ $schema: './projects.schema.json', repos: [] }, null, 2));

    expect(() => writeProjectsEntry(manifestPath, makeEntry(), 'no-such-repo')).toThrow(/no such repo/);
  });

  it('throws when the manifest file does not exist', () => {
    expect(() => writeProjectsEntry(join(tempDir, 'missing.json'), makeEntry())).toThrow(/not found/);
  });

  it('throws a clean error on malformed JSON', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    await writeFile(manifestPath, '{not-json');
    expect(() => writeProjectsEntry(manifestPath, makeEntry())).toThrow(/parse error/);
  });

  it('throws when manifest is missing a repos array', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    await writeFile(manifestPath, JSON.stringify({ $schema: './x' }));
    expect(() => writeProjectsEntry(manifestPath, makeEntry())).toThrow(/repos/);
  });

  it('writes a single trailing newline', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    await writeFile(manifestPath, JSON.stringify({ $schema: './projects.schema.json', repos: [] }, null, 2));

    writeProjectsEntry(manifestPath, makeEntry());

    const raw = readFileSync(manifestPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
  });
});

describe('writeLearnings', () => {
  it('creates .case/learnings.md when none exists', async () => {
    const findings = makeFindings();
    writeLearnings(tempDir, findings);

    const target = join(tempDir, '.case', 'learnings.md');
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('# Repo Learnings');
    expect(content).toContain('## Architecture');
    expect(content).toContain('## Testing');
  });

  it('appends under a separator when the file already exists', async () => {
    await mkdir(join(tempDir, '.case'), { recursive: true });
    const existing = '# Repo Learnings\n\n## Existing topic\n\nHand-written content.\n';
    await writeFile(join(tempDir, '.case', 'learnings.md'), existing);

    writeLearnings(tempDir, makeFindings());

    const content = readFileSync(join(tempDir, '.case', 'learnings.md'), 'utf-8');
    expect(content).toContain('Hand-written content.');
    expect(content).toContain('---');
    expect(content).toContain('## Architecture');
  });

  it('does nothing when there are no learnings to write', async () => {
    const findings = makeFindings({ learnings: [] });
    writeLearnings(tempDir, findings);
    expect(existsSync(join(tempDir, '.case', 'learnings.md'))).toBe(false);
  });

  it('reports the entry count to stdout', async () => {
    writeLearnings(tempDir, makeFindings());
    expect(stdout.lines.join('')).toContain('2 entries');
  });
});

describe('writeClaudeLocal', () => {
  it('writes a CLAUDE.local.md at the repo root', () => {
    writeClaudeLocal(tempDir, makeFindings());
    const target = join(tempDir, 'CLAUDE.local.md');
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('# CLAUDE.local.md');
    expect(content).toContain('Always run typecheck');
  });

  it('overwrites an existing CLAUDE.local.md (treated as generated)', async () => {
    const target = join(tempDir, 'CLAUDE.local.md');
    await writeFile(target, '# OLD CONTENT\n');

    writeClaudeLocal(tempDir, makeFindings());

    const content = readFileSync(target, 'utf-8');
    expect(content).not.toContain('OLD CONTENT');
    expect(content).toContain('Always run typecheck');
  });

  it('does nothing when there are no conventions to write', () => {
    const findings = makeFindings({ conventions: [] });
    writeClaudeLocal(tempDir, findings);
    expect(existsSync(join(tempDir, 'CLAUDE.local.md'))).toBe(false);
  });

  it('reports the convention count to stdout', () => {
    writeClaudeLocal(tempDir, makeFindings());
    expect(stdout.lines.join('')).toContain('1 conventions');
  });
});

describe('onboard CLI flag parsing', () => {
  let errCapture: ReturnType<typeof captureStream>;

  beforeEach(() => {
    errCapture = captureStream(process.stderr);
  });

  afterEach(() => {
    errCapture.restore();
  });

  it('shows usage when no positional argument and no --re-interview', async () => {
    const { handler } = await import('../commands/onboard.js');
    const code = await handler([]);
    expect(code).toBe(1);
    expect(errCapture.lines.join('')).toContain('Usage');
  });

  it('mentions --interview in --help', async () => {
    const { handler } = await import('../commands/onboard.js');
    const code = await handler(['--help']);
    expect(code).toBe(0);
    expect(errCapture.lines.join('')).toContain('--interview');
    expect(errCapture.lines.join('')).toContain('--re-interview');
  });

  it('exits 1 when --re-interview is given a name that does not match', async () => {
    process.env.CASE_DATA_DIR = tempDir;
    const manifestPath = join(tempDir, 'projects.json');
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          $schema: './projects.schema.json',
          repos: [makeEntry()],
        },
        null,
        2,
      ),
    );
    // ca init creates config.json; emulate that so loadProjectsManifest picks up the data dir.
    await writeFile(join(tempDir, 'config.json'), JSON.stringify({ projects: 'projects.json' }));

    try {
      const { handler } = await import('../commands/onboard.js');
      const code = await handler(['no-such-repo', '--re-interview']);
      expect(code).toBe(1);
      expect(errCapture.lines.join('')).toContain('not found');
    } finally {
      delete process.env.CASE_DATA_DIR;
    }
  });
});

describe('synthesis + writer integration', () => {
  it('writes a complete projects.json entry from interview findings', async () => {
    const manifestPath = join(tempDir, 'projects.json');
    await writeFile(manifestPath, JSON.stringify({ $schema: './projects.schema.json', repos: [] }, null, 2));

    const { synthesizeProjectEntry } = await import('../interview/findings.js');
    const detected = {
      name: 'authkit-nextjs',
      path: './authkit-nextjs',
      remote: 'git@github.com:workos/authkit-nextjs.git',
      language: 'typescript',
      packageManager: 'pnpm',
      description: 'mech desc',
      commands: { setup: 'pnpm install', test: 'pnpm test', build: 'pnpm build' },
      evidenceStrategy: 'ui-screenshot' as const,
    };
    const findings = makeFindings({
      evidenceStrategy: 'test-output',
      commandOverrides: { test: 'pnpm test:unit' },
    });

    const entry = synthesizeProjectEntry(findings, detected);
    writeProjectsEntry(manifestPath, entry);

    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(parsed.repos[0].evidenceStrategy).toBe('test-output');
    expect(parsed.repos[0].commands.test).toBe('pnpm test:unit');
    expect(parsed.repos[0].commands.build).toBe('pnpm build');
    expect(parsed.repos[0].verificationNotes).toBe('Set WORKOS_API_KEY before running tests.');
  });
});
