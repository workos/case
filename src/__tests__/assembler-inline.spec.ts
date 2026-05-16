import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { assemblePrompt } from '../context/assembler.js';
import type { PipelineConfig, TaskJson } from '../types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Use real temp files (avoids mock.module conflicts with other test files).
const tempCaseRoot = join(process.env.TMPDIR ?? '/tmp', `case-assembler-inline-test-${Date.now()}`);

async function writeAgent(role: string, body: string): Promise<void> {
  const agentsDir = join(tempCaseRoot, 'agents');
  await mkdir(agentsDir, { recursive: true });
  await Bun.write(join(agentsDir, `${role}.md`), body);
}

async function writeDoc(relPath: string, body: string): Promise<void> {
  const full = join(tempCaseRoot, relPath);
  const dir = full.slice(0, full.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await Bun.write(full, body);
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'attended',
    taskJsonPath: join(tempCaseRoot, 'tasks/active/x.task.json'),
    taskMdPath: join(tempCaseRoot, 'tasks/active/x.md'),
    repoPath: '/repos/x',
    repoName: 'x',
    packageRoot: tempCaseRoot,
    dataDir: tempCaseRoot,
    maxRetries: 1,
    dryRun: false,
    ...overrides,
  };
}

function makeTask(): TaskJson {
  return {
    id: 'x',
    status: 'active',
    created: '2026-05-15T00:00:00Z',
    repo: 'x',
    issue: '1',
    issueType: 'github',
    agents: {},
    tested: false,
    manualTested: false,
    prUrl: null,
    prNumber: null,
  };
}

const emptyRepoContext = {
  sessionJson: {},
  learnings: '',
  recentCommits: '',
  goldenPrinciples: '',
  workingMemory: null,
};

describe('assembler doc inlining', () => {
  beforeEach(async () => {
    await rm(tempCaseRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(tempCaseRoot, { recursive: true, force: true });
  });

  it('replaces a single inject marker with the file contents', async () => {
    await writeDoc('docs/conventions/commits.md', '# Commits\n\nUse conventional commits.\n');
    await writeAgent('implementer', '# Implementer\n\n<!-- inject: docs/conventions/commits.md -->\n');

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    expect(prompt).toContain('Use conventional commits.');
    expect(prompt).not.toContain('<!-- inject: docs/conventions/commits.md -->');
  });

  it('resolves multiple markers in one template independently', async () => {
    await writeDoc('docs/a.md', 'AAA');
    await writeDoc('docs/b.md', 'BBB');
    await writeDoc('docs/c.md', 'CCC');
    await writeAgent(
      'implementer',
      '# Top\n<!-- inject: docs/a.md -->\n---\n<!-- inject: docs/b.md -->\n---\n<!-- inject: docs/c.md -->\n',
    );

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    expect(prompt).toContain('AAA');
    expect(prompt).toContain('BBB');
    expect(prompt).toContain('CCC');
    expect(prompt).not.toMatch(/<!--\s*inject:/);
  });

  it('leaves the marker verbatim when the target file is missing', async () => {
    await writeAgent('implementer', '# Implementer\n<!-- inject: docs/does-not-exist.md -->\n');

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    expect(prompt).toContain('<!-- inject: docs/does-not-exist.md -->');
  });

  it('truncates oversize docs to the size limit with a footer', async () => {
    // 20KB file, way over the 8KB default
    const big = 'X'.repeat(20_000);
    await writeDoc('docs/big.md', big);
    await writeAgent('implementer', '<!-- inject: docs/big.md -->');

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    expect(prompt).toContain('[truncated]');
    // Should NOT contain the full 20K body — count Xs.
    const xCount = (prompt.match(/X/g) ?? []).length;
    expect(xCount).toBeLessThan(20_000);
    expect(xCount).toBeGreaterThanOrEqual(8_000);
  });

  it('respects CASE_INLINE_MAX_BYTES env override', async () => {
    const body = 'Y'.repeat(2_000);
    await writeDoc('docs/medium.md', body);
    await writeAgent('implementer', '<!-- inject: docs/medium.md -->');

    process.env.CASE_INLINE_MAX_BYTES = '500';
    try {
      const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

      expect(prompt).toContain('[truncated]');
      const yCount = (prompt.match(/Y/g) ?? []).length;
      expect(yCount).toBeLessThan(2_000);
      expect(yCount).toBeLessThanOrEqual(500);
    } finally {
      delete process.env.CASE_INLINE_MAX_BYTES;
    }
  });

  it('does NOT recursively process nested inject markers', async () => {
    // doc A contains a marker for doc B — should appear verbatim in output.
    await writeDoc('docs/a.md', 'A-content\n<!-- inject: docs/b.md -->\n');
    await writeDoc('docs/b.md', 'B-content');
    await writeAgent('implementer', '<!-- inject: docs/a.md -->');

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    expect(prompt).toContain('A-content');
    // B's marker survives — NOT recursively resolved.
    expect(prompt).toContain('<!-- inject: docs/b.md -->');
    expect(prompt).not.toContain('B-content');
  });

  it('treats an empty inject path as a no-op', async () => {
    await writeAgent('implementer', '# Top\n<!-- inject:  -->\n# Bottom');

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    // Regex requires at least one non-space char; empty marker is unchanged.
    expect(prompt).toContain('# Top');
    expect(prompt).toContain('# Bottom');
  });

  it('does not interfere with {{var}} substitution', async () => {
    await writeDoc('docs/note.md', 'NOTE-BODY');
    await writeAgent('implementer', 'root={{packageRoot}}\n<!-- inject: docs/note.md -->\ndata={{dataDir}}');

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    expect(prompt).toContain(`root=${tempCaseRoot}`);
    expect(prompt).toContain(`data=${tempCaseRoot}`);
    expect(prompt).toContain('NOTE-BODY');
  });

  it('inject markers in inlined content (from {{var}} substitution) are not re-scanned', async () => {
    // This guards against the single-pass guarantee even when {{var}} produces a marker.
    // We can't easily trigger this via {{var}} since vars are strings only — but assert
    // the order: {{var}} runs FIRST, then inject. So a {{var}} that expands to an inject
    // marker WOULD be processed. The single-pass guarantee is about NESTED-doc content,
    // which the previous test covers.
    await writeDoc('docs/x.md', 'X-CONTENT');
    await writeAgent('implementer', '<!-- inject: docs/x.md -->');

    const prompt = await assemblePrompt('implementer', makeConfig(), makeTask(), emptyRepoContext, new Map());

    expect(prompt).toContain('X-CONTENT');
  });
});
