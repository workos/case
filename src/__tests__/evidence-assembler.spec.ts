import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { mockSpawnAgent, mockRunScript, mockWriteRunMetrics, mockGetCurrentPromptVersions, mockFindPriorRunId } from './mocks.js';
import type { AgentName, AgentResult, PipelineConfig } from '../types.js';
import { assembleEvidence } from '../phases/evidence-assembler.js';
import { parseDiff } from '../phases/evidence-assembler.js';

// Suppress unused import warnings — mocks.ts must be imported for its side effects
void mockSpawnAgent; void mockWriteRunMetrics;
void mockGetCurrentPromptVersions; void mockFindPriorRunId;

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'attended',
    taskJsonPath: '/tmp/test.task.json',
    taskMdPath: '/tmp/test.md',
    repoPath: '/repos/cli',
    repoName: 'cli',
    caseRoot: '/tmp/case',
    maxRetries: 1,
    dryRun: false,
    approve: true,
    ...overrides,
  };
}

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    read: mock(() =>
      Promise.resolve({
        id: 'cli-42',
        status: 'approving',
        created: '2026-03-28T00:00:00Z',
        repo: 'cli',
        branch: 'fix/login-bug',
        issue: 'workos/cli#42',
        agents: {},
        tested: false,
        manualTested: false,
        prUrl: null,
        prNumber: null,
        ...overrides,
      }),
    ),
    readStatus: mock(),
    setStatus: mock(),
    setAgentPhase: mock(),
    setField: mock(),
    setPendingRevision: mock(),
  } as any;
}

const STAT_OUTPUT = ` src/foo.ts | 10 +++++++---
 src/bar.ts |  5 ++---
 2 files changed, 8 insertions(+), 4 deletions(-)
`;

const DIFF_OUTPUT = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,7 @@
 import { x } from 'y';

-const old = true;
+const updated = true;
+const extra = false;

 export { updated };
diff --git a/src/bar.ts b/src/bar.ts
new file mode 100644
--- /dev/null
+++ b/src/bar.ts
@@ -0,0 +1,3 @@
+export function bar() {
+  return 42;
+}
`;

const completedResult: AgentResult = {
  status: 'completed',
  summary: 'Done',
  artifacts: {
    commit: 'abc123',
    filesChanged: ['src/foo.ts', 'src/bar.ts'],
    testsPassed: true,
    screenshotUrls: [],
    evidenceMarkers: [],
    prUrl: null,
    prNumber: null,
  },
  error: null,
};

const verifierResult: AgentResult = {
  ...completedResult,
  summary: 'Verified OK',
  rubric: {
    role: 'verifier',
    categories: [
      { category: 'reproduced-scenario', verdict: 'pass', detail: 'OK' },
      { category: 'edge-case-checked', verdict: 'pass', detail: 'OK' },
    ],
  },
};

const reviewerResult: AgentResult = {
  ...completedResult,
  summary: 'Reviewed OK',
  findings: { critical: 0, warnings: 1, info: 2, details: [] },
  rubric: {
    role: 'reviewer',
    categories: [
      { category: 'principle-compliance', verdict: 'pass', detail: 'OK' },
      { category: 'scope-discipline', verdict: 'fail', detail: 'Minor creep' },
    ],
  },
};

describe('assembleEvidence', () => {
  let previousResults: Map<AgentName, AgentResult>;

  beforeEach(() => {
    mockRunScript.mockReset();
    previousResults = new Map();
    previousResults.set('implementer', completedResult);
    previousResults.set('verifier', verifierResult);
    previousResults.set('reviewer', reviewerResult);

    // Default: git commands succeed
    mockRunScript.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--stat')) {
        return Promise.resolve({ stdout: STAT_OUTPUT, stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: DIFF_OUTPUT, stderr: '', exitCode: 0 });
    });
  });

  it('assembles task metadata from store', async () => {
    const evidence = await assembleEvidence(makeConfig(), makeStore(), previousResults);

    expect(evidence.task.id).toBe('cli-42');
    expect(evidence.task.repo).toBe('cli');
    expect(evidence.task.branch).toBe('fix/login-bug');
    expect(evidence.task.issue).toBe('workos/cli#42');
  });

  it('parses diff stat summary', async () => {
    const evidence = await assembleEvidence(makeConfig(), makeStore(), previousResults);

    expect(evidence.diff.summary.filesChanged).toBe(2);
    expect(evidence.diff.summary.additions).toBe(8);
    expect(evidence.diff.summary.deletions).toBe(4);
  });

  it('parses diff into structured files with hunks', async () => {
    const evidence = await assembleEvidence(makeConfig(), makeStore(), previousResults);

    expect(evidence.diff.files).toHaveLength(2);
    expect(evidence.diff.files[0].path).toBe('src/foo.ts');
    expect(evidence.diff.files[0].status).toBe('modified');
    expect(evidence.diff.files[0].hunks).toHaveLength(1);
    expect(evidence.diff.files[1].path).toBe('src/bar.ts');
    expect(evidence.diff.files[1].status).toBe('added');
  });

  it('extracts test results from implementer', async () => {
    const evidence = await assembleEvidence(makeConfig(), makeStore(), previousResults);

    expect(evidence.tests.passed).toBe(true);
    expect(evidence.commit).toBe('abc123');
  });

  it('extracts verifier rubric', async () => {
    const evidence = await assembleEvidence(makeConfig(), makeStore(), previousResults);

    expect(evidence.verifier.ran).toBe(true);
    expect(evidence.verifier.rubric).toHaveLength(2);
    expect(evidence.verifier.summary).toBe('Verified OK');
  });

  it('extracts reviewer rubric and findings', async () => {
    const evidence = await assembleEvidence(makeConfig(), makeStore(), previousResults);

    expect(evidence.reviewer.ran).toBe(true);
    expect(evidence.reviewer.rubric).toHaveLength(2);
    expect(evidence.reviewer.findings?.critical).toBe(0);
    expect(evidence.reviewer.findings?.warnings).toBe(1);
  });

  it('handles missing verifier (tiny profile)', async () => {
    previousResults.delete('verifier');

    const evidence = await assembleEvidence(makeConfig(), makeStore(), previousResults);

    expect(evidence.verifier.ran).toBe(false);
    expect(evidence.verifier.rubric).toBeNull();
    expect(evidence.verifier.summary).toBeNull();
  });

  it('handles missing all results', async () => {
    const empty = new Map<AgentName, AgentResult>();

    const evidence = await assembleEvidence(makeConfig(), makeStore(), empty);

    expect(evidence.tests.passed).toBeNull();
    expect(evidence.verifier.ran).toBe(false);
    expect(evidence.reviewer.ran).toBe(false);
    expect(evidence.commit).toBeNull();
    expect(evidence.screenshots).toEqual([]);
  });

  it('handles git diff failure gracefully', async () => {
    mockRunScript.mockImplementation(() =>
      Promise.resolve({ stdout: '', stderr: 'fatal: no commits', exitCode: 1 }),
    );

    const evidence = await assembleEvidence(makeConfig(), makeStore(), previousResults);

    expect(evidence.diff.summary.filesChanged).toBe(0);
    expect(evidence.diff.files).toEqual([]);
  });

  it('collects screenshots from all agent results', async () => {
    const withScreenshots: AgentResult = {
      ...completedResult,
      artifacts: {
        ...completedResult.artifacts,
        screenshotUrls: ['file:///tmp/screenshots/login.png', '/tmp/screenshots/dashboard.png'],
      },
    };
    previousResults.set('implementer', withScreenshots);

    const evidence = await assembleEvidence(makeConfig(), makeStore(), previousResults);

    expect(evidence.screenshots).toHaveLength(2);
    expect(evidence.screenshots[0]).toBe('/tmp/screenshots/login.png');
    expect(evidence.screenshots[1]).toBe('/tmp/screenshots/dashboard.png');
  });
});

describe('parseDiff', () => {
  it('returns empty array for empty diff', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('  \n  ')).toEqual([]);
  });

  it('handles binary files', () => {
    const binary = `diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
`;
    const files = parseDiff(binary);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('logo.png');
    expect(files[0].status).toBe('added');
    expect(files[0].hunks).toEqual([]);
  });

  it('detects rename status', () => {
    const renamed = `diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,1 @@
-old
+new
`;
    const files = parseDiff(renamed);
    expect(files[0].status).toBe('renamed');
  });

  it('counts additions and deletions per file', () => {
    const files = parseDiff(DIFF_OUTPUT);
    // foo.ts: -1 old, +2 new
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    // bar.ts: +3 new lines
    expect(files[1].additions).toBe(3);
    expect(files[1].deletions).toBe(0);
  });
});
