import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Pi-runner integration tests.
 *
 * The preloaded mocks (mocks.ts) replace `spawnAgent` at the module level,
 * so we can't import the real pi-runner.ts directly. Instead, we test the
 * component functions that pi-runner composes:
 *
 * 1. getToolsForAgent (tool-sets.ts) — tool scoping per agent role
 * 2. loadSystemPrompt (prompt-loader.ts) — frontmatter stripping
 *
 * The spawnAgent integration (Agent creation → event subscription → AGENT_RESULT parsing)
 * is verified through the existing phase tests (implement-phase.spec.ts, pipeline.spec.ts)
 * which exercise the full pipeline with mockSpawnAgent.
 */

// These modules are NOT mocked by the preload — we can test them directly
const { getToolsForAgent } = await import('../agent/tool-sets.js');
const { loadSystemPrompt } = await import('../agent/prompt-loader.js');

// --- tool-sets tests ---

describe('getToolsForAgent', () => {
  it('implementer gets full write access (read, write, edit, bash)', () => {
    const tools = getToolsForAgent('implementer', '/repos/cli');
    const names = tools.map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('bash');
    expect(names.length).toBe(4);
  });

  it('reviewer gets read-only + bash', () => {
    const tools = getToolsForAgent('reviewer', '/repos/cli');
    const names = tools.map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('bash');
    expect(names.length).toBe(2);
  });

  it('verifier gets read-only + bash', () => {
    const tools = getToolsForAgent('verifier', '/repos/cli');
    const names = tools.map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('bash');
    expect(names.length).toBe(2);
  });

  it('closer gets read-only + bash', () => {
    const tools = getToolsForAgent('closer', '/repos/cli');
    const names = tools.map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('bash');
    expect(names.length).toBe(2);
  });

  it('retrospective gets full write access', () => {
    const tools = getToolsForAgent('retrospective', '/repos/cli');
    const names = tools.map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('bash');
    expect(names.length).toBe(4);
  });

  it('unknown agent defaults to read-only + bash', () => {
    const tools = getToolsForAgent('unknown-agent', '/repos/cli');
    const names = tools.map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('bash');
    expect(names.length).toBe(2);
  });
});

// --- prompt-loader tests ---

const tempDir = join(process.env.TMPDIR ?? '/tmp', `case-prompt-test-${Date.now()}`);

describe('loadSystemPrompt', () => {
  beforeEach(async () => {
    await mkdir(join(tempDir, 'agents'), { recursive: true });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('strips YAML frontmatter and returns markdown body', async () => {
    await Bun.write(
      join(tempDir, 'agents/implementer.md'),
      `---
name: implementer
description: Focused code implementation agent
tools: ['Read', 'Edit', 'Write', 'Bash']
---

# Implementer

You are the implementer agent.`,
    );

    const prompt = await loadSystemPrompt(tempDir, 'implementer');
    expect(prompt).toBe('# Implementer\n\nYou are the implementer agent.');
    expect(prompt).not.toContain('---');
    expect(prompt).not.toContain('tools:');
  });

  it('handles agent file with no frontmatter', async () => {
    await Bun.write(join(tempDir, 'agents/plain.md'), '# Plain Agent\n\nNo frontmatter here.');

    const prompt = await loadSystemPrompt(tempDir, 'plain');
    expect(prompt).toBe('# Plain Agent\n\nNo frontmatter here.');
  });

  it('handles frontmatter with model field', async () => {
    await Bun.write(
      join(tempDir, 'agents/reviewer.md'),
      `---
name: reviewer
description: Review agent
tools: ['Read', 'Bash']
model: sonnet
---

# Reviewer`,
    );

    const prompt = await loadSystemPrompt(tempDir, 'reviewer');
    expect(prompt).toBe('# Reviewer');
    expect(prompt).not.toContain('model: sonnet');
  });

  it('throws on missing agent file', async () => {
    await expect(loadSystemPrompt(tempDir, 'nonexistent')).rejects.toThrow();
  });
});
