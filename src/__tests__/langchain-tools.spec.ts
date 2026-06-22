import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * LangChain agent tool tests — the working-tree primitives handed to non-Claude
 * models. Verifies policy gating (read-only vs mutable) and the actual
 * read/bash/edit/write behavior on a temp workspace.
 */

const { createLangchainTools } = await import('../agent/tools/langchain/index.js');

const tmp = join(process.env.TMPDIR ?? '/tmp', `case-lc-tools-${Date.now()}`);

type LCTool = { name: string; invoke: (input: unknown) => Promise<string> };
function byName(tools: unknown[]): Map<string, LCTool> {
  return new Map((tools as LCTool[]).map((t) => [t.name, t]));
}

describe('createLangchainTools policy gating', () => {
  it('read-only roles get [read, bash] only', () => {
    for (const role of ['scout', 'reviewer', 'verifier', 'closer', 'interviewer', 'unknown']) {
      const names = (createLangchainTools(role, tmp) as LCTool[]).map((t) => t.name).sort();
      expect(names).toEqual(['bash', 'read']);
    }
  });

  it('mutable roles add [write, edit]', () => {
    for (const role of ['implementer', 'retrospective']) {
      const names = (createLangchainTools(role, tmp) as LCTool[]).map((t) => t.name).sort();
      expect(names).toEqual(['bash', 'edit', 'read', 'write']);
    }
  });
});

describe('LangChain tool behavior', () => {
  beforeEach(async () => {
    await mkdir(tmp, { recursive: true });
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('read returns file content (relative path resolved against cwd)', async () => {
    await writeFile(join(tmp, 'hello.txt'), 'hello world', 'utf8');
    const read = byName(createLangchainTools('scout', tmp)).get('read')!;
    expect(await read.invoke({ path: 'hello.txt' })).toBe('hello world');
  });

  it('bash runs in the workspace cwd', async () => {
    await writeFile(join(tmp, 'marker.txt'), 'x', 'utf8');
    const bash = byName(createLangchainTools('scout', tmp)).get('bash')!;
    const out = await bash.invoke({ command: 'ls' });
    expect(out).toContain('marker.txt');
  });

  it('write creates a file', async () => {
    const write = byName(createLangchainTools('implementer', tmp)).get('write')!;
    await write.invoke({ path: 'new.txt', content: 'created' });
    expect(await readFile(join(tmp, 'new.txt'), 'utf8')).toBe('created');
  });

  it('edit replaces an exact unique string', async () => {
    await writeFile(join(tmp, 'edit.txt'), 'foo bar baz', 'utf8');
    const edit = byName(createLangchainTools('implementer', tmp)).get('edit')!;
    await edit.invoke({ path: 'edit.txt', old_string: 'bar', new_string: 'QUX' });
    expect(await readFile(join(tmp, 'edit.txt'), 'utf8')).toBe('foo QUX baz');
  });

  it('edit refuses a non-unique string without replace_all', async () => {
    await writeFile(join(tmp, 'dup.txt'), 'a a a', 'utf8');
    const edit = byName(createLangchainTools('implementer', tmp)).get('edit')!;
    const res = await edit.invoke({ path: 'dup.txt', old_string: 'a', new_string: 'b' });
    expect(res).toContain('not unique');
    expect(await readFile(join(tmp, 'dup.txt'), 'utf8')).toBe('a a a');
  });

  it('edit replace_all replaces every occurrence', async () => {
    await writeFile(join(tmp, 'all.txt'), 'a a a', 'utf8');
    const edit = byName(createLangchainTools('implementer', tmp)).get('edit')!;
    await edit.invoke({ path: 'all.txt', old_string: 'a', new_string: 'b', replace_all: true });
    expect(await readFile(join(tmp, 'all.txt'), 'utf8')).toBe('b b b');
  });
});
