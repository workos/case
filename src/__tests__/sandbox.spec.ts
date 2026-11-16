import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedAgentDir } from '../agent/isolated-agent-dir.js';
import { createGuardedReadTool } from '../agent/sandbox.js';

let root: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'case-sandbox-'));
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(root, { recursive: true, force: true });
});

const read = (path: string) => createGuardedReadTool(root).execute('call', { path }, undefined, undefined, {} as never);

describe('createGuardedReadTool', () => {
  it('hides a custom Pi config dir, directly and through an isolated session auth link', async () => {
    const customAgentDir = join(root, 'custom-pi');
    mkdirSync(customAgentDir);
    writeFileSync(join(customAgentDir, 'auth.json'), '{"secret":true}');
    writeFileSync(join(customAgentDir, 'models.json'), '{"apiKey":"x"}');
    writeFileSync(join(root, 'ok.txt'), 'fine');

    process.env.PI_CODING_AGENT_DIR = customAgentDir;
    await expect(read(join(customAgentDir, 'auth.json'))).rejects.toThrow('Access denied');

    const isolated = createIsolatedAgentDir('case-sandbox-test-', customAgentDir);
    process.env.PI_CODING_AGENT_DIR = isolated;
    await expect(read(join(isolated, 'auth.json'))).rejects.toThrow('Access denied');
    await expect(read(join(customAgentDir, 'models.json'))).rejects.toThrow('Access denied');
    rmSync(isolated, { recursive: true, force: true });

    const ok = await read(join(root, 'ok.txt'));
    expect(JSON.stringify(ok.content)).toContain('fine');
  });
});
