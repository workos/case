import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

describe('onboard — evidence strategy inference', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(process.env.TMPDIR ?? '/tmp', `case-onboard-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('infers scenario-script for a library with build', async () => {
    const { inferEvidenceStrategy } = await importOnboardInternals();
    const repoDir = join(tempDir, 'my-lib');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } }));

    const result = inferEvidenceStrategy(repoDir, { setup: 'pnpm install', test: 'pnpm test', build: 'pnpm build' });
    expect(result).toBe('scenario-script');
  });

  it('infers test-output for a repo with only test command', async () => {
    const { inferEvidenceStrategy } = await importOnboardInternals();
    const repoDir = join(tempDir, 'simple');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));

    const result = inferEvidenceStrategy(repoDir, { setup: 'pnpm install', test: 'pnpm test' });
    expect(result).toBe('test-output');
  });

  it('infers ui-screenshot for a Next.js app', async () => {
    const { inferEvidenceStrategy } = await importOnboardInternals();
    const repoDir = join(tempDir, 'my-app');
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'next dev', test: 'vitest' }, dependencies: { next: '^14' } }),
    );

    const result = inferEvidenceStrategy(repoDir, { setup: 'pnpm install', test: 'pnpm test' });
    expect(result).toBe('ui-screenshot');
  });

  it('infers ui-screenshot when examples/ directory exists', async () => {
    const { inferEvidenceStrategy } = await importOnboardInternals();
    const repoDir = join(tempDir, 'with-examples');
    await mkdir(join(repoDir, 'examples'), { recursive: true });
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));

    const result = inferEvidenceStrategy(repoDir, { setup: 'pnpm install', test: 'pnpm test' });
    expect(result).toBe('ui-screenshot');
  });
});

describe('onboard handler', () => {
  let errCapture: ReturnType<typeof captureStream>;

  beforeEach(() => {
    errCapture = captureStream(process.stderr);
  });

  afterEach(() => {
    errCapture.restore();
  });

  it('exits 1 with usage when no path given', async () => {
    const { handler } = await import('../commands/onboard.js');
    const code = await handler([]);
    expect(code).toBe(1);
    expect(errCapture.lines.join('')).toContain('Usage');
  });

  it('exits 0 with --help', async () => {
    const { handler } = await import('../commands/onboard.js');
    const code = await handler(['--help']);
    expect(code).toBe(0);
  });

  it('exits 1 for non-existent path', async () => {
    const { handler } = await import('../commands/onboard.js');
    const code = await handler(['/nonexistent/repo/path']);
    expect(code).toBe(1);
    expect(errCapture.lines.join('')).toContain('path not found');
  });
});

async function importOnboardInternals() {
  // The inference function is not exported — test via a re-export or inline.
  // For now, import the module and test the handler behavior.
  // To unit-test inferEvidenceStrategy, we export it.
  const mod = await import('../commands/onboard.js');
  return mod as any;
}
