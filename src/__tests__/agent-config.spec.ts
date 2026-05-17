import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Agent config tests use CASE_DATA_DIR so they never touch real user config.
 */

const { loadConfig, getModelForAgent } = await import('../agent/config.js');

let tempDir: string;
let originalCaseDataDir: string | undefined;
let originalXdgConfigHome: string | undefined;

async function writeConfig(config: unknown): Promise<void> {
  await Bun.write(join(tempDir, 'config.json'), JSON.stringify(config));
}

describe('agent config', () => {
  beforeEach(async () => {
    originalCaseDataDir = process.env.CASE_DATA_DIR;
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    tempDir = await mkdtemp(join(tmpdir(), 'case-agent-config-'));
    await mkdir(tempDir, { recursive: true });
    process.env.CASE_DATA_DIR = tempDir;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.CASE_MODEL_OVERRIDE;
  });

  afterEach(async () => {
    if (originalCaseDataDir === undefined) delete process.env.CASE_DATA_DIR;
    else process.env.CASE_DATA_DIR = originalCaseDataDir;

    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

    delete process.env.CASE_MODEL_OVERRIDE;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty config when file is missing', async () => {
    const config = await loadConfig();
    expect(config).toEqual({});
  });

  it('returns parsed config from file', async () => {
    await writeConfig({
      models: {
        default: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        reviewer: { provider: 'google', model: 'gemini-2.5-pro' },
      },
    });

    const config = await loadConfig();
    expect(config.models?.default?.provider).toBe('anthropic');
    expect(config.models?.reviewer).toEqual({ provider: 'google', model: 'gemini-2.5-pro' });
  });

  it('returns empty config for invalid JSON', async () => {
    await Bun.write(join(tempDir, 'config.json'), 'not json {{{');
    const config = await loadConfig();
    expect(config).toEqual({});
  });

  it('returns hardcoded default when no config file exists', async () => {
    const result = await getModelForAgent('implementer');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('uses role-specific config when available', async () => {
    await writeConfig({
      models: {
        default: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        reviewer: { provider: 'google', model: 'gemini-2.5-pro' },
      },
    });

    const result = await getModelForAgent('reviewer');
    expect(result).toEqual({ provider: 'google', model: 'gemini-2.5-pro' });
  });

  it('falls back to default when role is null', async () => {
    await writeConfig({
      models: {
        default: { provider: 'anthropic', model: 'claude-opus-4-5' },
        verifier: null,
      },
    });

    const result = await getModelForAgent('verifier');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-opus-4-5' });
  });

  it('falls back to default when role is not in config', async () => {
    await writeConfig({
      models: {
        default: { provider: 'openai', model: 'gpt-4o' },
      },
    });

    const result = await getModelForAgent('closer');
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('falls back to hardcoded default when default is not in config', async () => {
    await writeConfig({
      models: {
        reviewer: { provider: 'google', model: 'gemini-2.5-pro' },
      },
    });

    const result = await getModelForAgent('implementer');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('handles orchestrator role', async () => {
    await writeConfig({
      models: {
        orchestrator: { provider: 'anthropic', model: 'claude-opus-4-5' },
      },
    });

    const result = await getModelForAgent('orchestrator');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-opus-4-5' });
  });
});
