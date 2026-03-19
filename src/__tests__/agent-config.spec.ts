import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Agent config tests.
 *
 * Tests config loading, role fallbacks, missing files, and env var overrides.
 * Uses real filesystem (temp config file) since the config loader reads from
 * ~/.config/case/config.json. We back up and restore the real file if it exists.
 */

const CONFIG_DIR = resolve(homedir(), '.config/case');
const CONFIG_PATH = resolve(CONFIG_DIR, 'config.json');
const BACKUP_PATH = resolve(CONFIG_DIR, 'config.json.test-backup');

let originalConfigExists = false;

const { loadConfig, getModelForAgent } = await import('../agent/config.js');

describe('loadConfig', () => {
  beforeEach(async () => {
    await mkdir(CONFIG_DIR, { recursive: true });
    // Back up existing config
    try {
      const existing = await Bun.file(CONFIG_PATH).text();
      await Bun.write(BACKUP_PATH, existing);
      originalConfigExists = true;
    } catch {
      originalConfigExists = false;
    }
  });

  afterEach(async () => {
    // Restore original config
    if (originalConfigExists) {
      const backup = await Bun.file(BACKUP_PATH).text();
      await Bun.write(CONFIG_PATH, backup);
    } else {
      try {
        await rm(CONFIG_PATH);
      } catch {
        // May not exist
      }
    }
    try {
      await rm(BACKUP_PATH);
    } catch {
      // May not exist
    }
  });

  it('returns empty config when file is missing', async () => {
    try {
      await rm(CONFIG_PATH);
    } catch {
      // Already missing
    }
    const config = await loadConfig();
    expect(config).toEqual({});
  });

  it('returns parsed config from file', async () => {
    await Bun.write(
      CONFIG_PATH,
      JSON.stringify({
        models: {
          default: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          reviewer: { provider: 'google', model: 'gemini-2.5-pro' },
        },
      }),
    );

    const config = await loadConfig();
    expect(config.models?.default?.provider).toBe('anthropic');
    expect(config.models?.reviewer).toEqual({ provider: 'google', model: 'gemini-2.5-pro' });
  });

  it('returns empty config for invalid JSON', async () => {
    await Bun.write(CONFIG_PATH, 'not json {{{');
    const config = await loadConfig();
    expect(config).toEqual({});
  });
});

describe('getModelForAgent', () => {
  beforeEach(async () => {
    await mkdir(CONFIG_DIR, { recursive: true });
    // Back up existing config
    try {
      const existing = await Bun.file(CONFIG_PATH).text();
      await Bun.write(BACKUP_PATH, existing);
      originalConfigExists = true;
    } catch {
      originalConfigExists = false;
    }
    // Clean env var
    delete process.env.CASE_MODEL_OVERRIDE;
  });

  afterEach(async () => {
    if (originalConfigExists) {
      const backup = await Bun.file(BACKUP_PATH).text();
      await Bun.write(CONFIG_PATH, backup);
    } else {
      try {
        await rm(CONFIG_PATH);
      } catch {}
    }
    try {
      await rm(BACKUP_PATH);
    } catch {}
    delete process.env.CASE_MODEL_OVERRIDE;
  });

  it('returns hardcoded default when no config file exists', async () => {
    try {
      await rm(CONFIG_PATH);
    } catch {}

    const result = await getModelForAgent('implementer');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('uses role-specific config when available', async () => {
    await Bun.write(
      CONFIG_PATH,
      JSON.stringify({
        models: {
          default: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          reviewer: { provider: 'google', model: 'gemini-2.5-pro' },
        },
      }),
    );

    const result = await getModelForAgent('reviewer');
    expect(result).toEqual({ provider: 'google', model: 'gemini-2.5-pro' });
  });

  it('falls back to default when role is null', async () => {
    await Bun.write(
      CONFIG_PATH,
      JSON.stringify({
        models: {
          default: { provider: 'anthropic', model: 'claude-opus-4-5' },
          verifier: null,
        },
      }),
    );

    const result = await getModelForAgent('verifier');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-opus-4-5' });
  });

  it('falls back to default when role is not in config', async () => {
    await Bun.write(
      CONFIG_PATH,
      JSON.stringify({
        models: {
          default: { provider: 'openai', model: 'gpt-4o' },
        },
      }),
    );

    const result = await getModelForAgent('closer');
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('falls back to hardcoded default when default is not in config', async () => {
    await Bun.write(
      CONFIG_PATH,
      JSON.stringify({
        models: {
          reviewer: { provider: 'google', model: 'gemini-2.5-pro' },
        },
      }),
    );

    const result = await getModelForAgent('implementer');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('handles orchestrator role', async () => {
    await Bun.write(
      CONFIG_PATH,
      JSON.stringify({
        models: {
          orchestrator: { provider: 'anthropic', model: 'claude-opus-4-5' },
        },
      }),
    );

    const result = await getModelForAgent('orchestrator');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-opus-4-5' });
  });
});
