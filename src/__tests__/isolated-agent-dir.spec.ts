import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedAgentDir } from '../agent/isolated-agent-dir.js';

let root: string;
let originalTmpdir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'case-isolated-agent-dir-'));
  originalTmpdir = process.env.TMPDIR;
});

afterEach(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  rmSync(root, { recursive: true, force: true });
});

describe('createIsolatedAgentDir', () => {
  it('creates a new private directory for each session, holding only the auth link, even when TMPDIR does not exist yet', () => {
    const realAgentDir = join(root, 'pi-agent');
    mkdirSync(realAgentDir);
    writeFileSync(join(realAgentDir, 'auth.json'), '{}');
    const tmp = join(root, 'missing', 'tmp');
    process.env.TMPDIR = tmp;

    const first = createIsolatedAgentDir('case-test-pi-', realAgentDir);
    const second = createIsolatedAgentDir('case-test-pi-', realAgentDir);

    expect(first).not.toBe(second);
    for (const dir of [first, second]) {
      expect(dir.startsWith(join(tmp, 'case-test-pi-'))).toBe(true);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir)).toEqual(['auth.json']);
      expect(readlinkSync(join(dir, 'auth.json'))).toBe(join(realAgentDir, 'auth.json'));
    }
  });
});
