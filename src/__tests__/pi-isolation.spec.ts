import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isolatePiRuntime, piExtensionsDisabled } from '../agent/pi-isolation.js';

/**
 * pi-isolation links exactly the provider/auth config a real ~/.pi/agent needs
 * to resolve model credentials, while leaving global extensions/themes behind.
 *
 * Regression guard for td-9339cd: a user whose default model is served by an
 * extension provider (gateway) hit "No API key found for anthropic" because
 * isolation linked only auth.json — dropping settings.json (packages,
 * defaultProvider) and the installed npm package that registers the provider.
 */
describe('isolatePiRuntime', () => {
  let fakeRealDir: string;
  let savedAgentDir: string | undefined;
  let savedTmpdir: string | undefined;
  let savedNoExt: string | undefined;

  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    savedTmpdir = process.env.TMPDIR;
    savedNoExt = process.env.CASE_PI_NO_EXTENSIONS;
    delete process.env.CASE_PI_NO_EXTENSIONS;

    fakeRealDir = join(tmpdir(), `case-iso-test-real-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(fakeRealDir, { recursive: true });

    // Provider/auth config that MUST survive isolation.
    writeFileSync(join(fakeRealDir, 'auth.json'), '{}');
    writeFileSync(join(fakeRealDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-gateway'], defaultProvider: 'gateway' }));
    mkdirSync(join(fakeRealDir, 'npm', 'node_modules', 'pi-gateway'), { recursive: true });

    // Global extension noise that MUST be left behind.
    mkdirSync(join(fakeRealDir, 'extensions', 'pi-subagents'), { recursive: true });
    mkdirSync(join(fakeRealDir, 'themes'), { recursive: true });

    // getAgentDir() reads PI_CODING_AGENT_DIR — point it at the fake real dir.
    process.env.PI_CODING_AGENT_DIR = fakeRealDir;
    process.env.TMPDIR = tmpdir();
  });

  afterEach(() => {
    const iso = process.env.PI_CODING_AGENT_DIR;
    if (iso && iso !== fakeRealDir) rmSync(iso, { recursive: true, force: true });
    rmSync(fakeRealDir, { recursive: true, force: true });
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    if (savedNoExt === undefined) delete process.env.CASE_PI_NO_EXTENSIONS;
    else process.env.CASE_PI_NO_EXTENSIONS = savedNoExt;
  });

  it('redirects PI_CODING_AGENT_DIR to an isolated temp dir', () => {
    const { realAgentDir, isolatedAgentDir } = isolatePiRuntime('unit');
    expect(realAgentDir).toBe(fakeRealDir);
    expect(isolatedAgentDir).not.toBe(fakeRealDir);
    expect(isolatedAgentDir).toContain('case-unit-pi-');
    expect(process.env.PI_CODING_AGENT_DIR).toBe(isolatedAgentDir);
    expect(existsSync(isolatedAgentDir)).toBe(true);
  });

  it('links auth.json, settings.json, and npm into isolation', () => {
    const { isolatedAgentDir } = isolatePiRuntime('unit');
    for (const name of ['auth.json', 'settings.json', 'npm']) {
      const linked = join(isolatedAgentDir, name);
      expect(existsSync(linked)).toBe(true);
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(realpathSync(linked)).toBe(realpathSync(join(fakeRealDir, name)));
    }
    // The installed provider package resolves through the npm symlink.
    expect(existsSync(join(isolatedAgentDir, 'npm', 'node_modules', 'pi-gateway'))).toBe(true);
  });

  it('does not link global extensions or themes', () => {
    const { isolatedAgentDir } = isolatePiRuntime('unit');
    expect(existsSync(join(isolatedAgentDir, 'extensions'))).toBe(false);
    expect(existsSync(join(isolatedAgentDir, 'themes'))).toBe(false);
  });

  it('with CASE_PI_NO_EXTENSIONS, links only auth.json (vanilla provider)', () => {
    process.env.CASE_PI_NO_EXTENSIONS = '1';
    expect(piExtensionsDisabled()).toBe(true);
    const { isolatedAgentDir } = isolatePiRuntime('unit');
    expect(existsSync(join(isolatedAgentDir, 'auth.json'))).toBe(true);
    expect(existsSync(join(isolatedAgentDir, 'settings.json'))).toBe(false);
    expect(existsSync(join(isolatedAgentDir, 'npm'))).toBe(false);
  });

  it('skips config that does not exist in the real dir', () => {
    rmSync(join(fakeRealDir, 'settings.json'));
    const { isolatedAgentDir } = isolatePiRuntime('unit');
    expect(existsSync(join(isolatedAgentDir, 'settings.json'))).toBe(false);
    // Present config is still linked.
    expect(existsSync(join(isolatedAgentDir, 'auth.json'))).toBe(true);
  });
});
