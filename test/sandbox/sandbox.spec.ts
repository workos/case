/**
 * Proves agent tools are sandboxed for real (bubblewrap on Linux, sandbox-exec on macOS):
 * credentials hidden, secrets stripped from env, writes confined to the repo and /tmp,
 * and the `ca --agent` session has no bash.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createAgentSession, SessionManager } from '@mariozechner/pi-coding-agent';

// Outside /tmp so "write outside the repo and /tmp" is meaningful.
const root = mkdtempSync('/var/tmp/case-sandbox-test-');
const home = join(root, 'home');
const repo = join(root, 'repo');
const SECRET = ['sandbox', 'leak', 'canary'].join('-');
const tmpProbe = `/tmp/case-sandbox-test-${process.pid}`;

for (const [file, content] of [
  ['.ssh/id_rsa', SECRET],
  ['.config/gh/hosts.yml', SECRET],
  ['.aws/credentials', SECRET],
  ['.npmrc', SECRET],
  ['.git-credentials', SECRET],
] as const) {
  mkdirSync(join(home, file, '..'), { recursive: true });
  writeFileSync(join(home, file), content);
}
mkdirSync(repo);
spawnSync('git', ['init', '-q', repo]);
spawnSync('git', ['-C', repo, 'config', 'user.name', 'Sandbox Tester']);
spawnSync('git', ['-C', repo, 'config', 'user.email', 'sandbox@example.com']);

process.env.HOME = home;
process.env.GH_TOKEN = SECRET;
process.env.ANTHROPIC_API_KEY = SECRET;

const { PiRuntimeAdapter } = await import('../../src/agent/adapters/pi-adapter.js');
const { orchestratorTools } = await import('../../src/agent/orchestrator-session.js');

type Tool = { name: string; execute: (id: string, params: object) => Promise<{ content: { text?: string }[] }> };
const adapter = new PiRuntimeAdapter();
const tool = (role: string, name: string) => (adapter.createTools(role, repo) as Tool[]).find((t) => t.name === name)!;
const run = async (t: Tool, params: object) => (await t.execute('test', params)).content.map((c) => c.text).join('');

const supported = SandboxManager.isSupportedPlatform() && SandboxManager.checkDependencies().errors.length === 0;

afterAll(async () => {
  await SandboxManager.reset();
  for (const dir of [root, process.env.CLAUDE_CODE_TMPDIR]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!supported)('agent sandbox', () => {
  for (const role of ['scout', 'implementer', 'verifier', 'reviewer', 'closer', 'retrospective', 'interviewer']) {
    it(`${role}: bash hides credentials, strips secrets, and confines writes`, async () => {
      const out = await run(tool(role, 'bash'), {
        command: [
          'cat ~/.ssh/id_rsa ~/.config/gh/hosts.yml ~/.aws/credentials ~/.npmrc ~/.git-credentials 2>&1',
          'env',
          "cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'",
          `echo x > ~/pwned-${role} 2>/dev/null && echo HOME_WRITTEN`,
          'echo x > .git/hooks/pre-push 2>/dev/null && echo HOOK_WRITTEN',
          `echo x > repo-${role}.txt && echo REPO_WRITTEN`,
          `echo x > ${tmpProbe}-${role} && echo TMP_WRITTEN && rm ${tmpProbe}-${role}`,
          'curl -s -m 5 https://example.com >/dev/null 2>&1 || echo NET_BLOCKED',
          'true',
        ].join('; '),
      });

      expect(out).not.toContain(SECRET);
      expect(out).toContain('GIT_CONFIG_GLOBAL=/dev/null');
      expect(out).toContain('REPO_WRITTEN');
      expect(out).toContain('TMP_WRITTEN');
      expect(out).toContain('NET_BLOCKED');
      expect(out).not.toContain('HOME_WRITTEN');
      expect(out).not.toContain('HOOK_WRITTEN');
      expect(existsSync(join(home, `pwned-${role}`))).toBe(false);
    });

    it(`${role}: read tool refuses credential files and /proc`, async () => {
      const read = tool(role, 'read');
      await expect(run(read, { path: join(home, '.ssh/id_rsa') })).rejects.toThrow('Access denied');
      await expect(run(read, { path: join(home, '.config/gh/hosts.yml') })).rejects.toThrow('Access denied');
      await expect(run(read, { path: '/proc/self/environ' })).rejects.toThrow('Access denied');
    });
  }

  it('implementer: git commit works inside the sandbox with the forwarded identity', async () => {
    const out = await run(tool('implementer', 'bash'), {
      command: 'echo a > a.txt && git add a.txt && git commit -qm sandboxed && git log -1 --format=%an',
    });
    expect(out).toContain('Sandbox Tester');
  });

  it('implementer: write tool stays inside the repo and out of .git', async () => {
    const write = tool('implementer', 'write');
    await run(write, { path: 'src/ok.ts', content: 'ok' });
    expect(existsSync(join(repo, 'src/ok.ts'))).toBe(true);
    await expect(run(write, { path: join(home, 'pwned'), content: 'x' })).rejects.toThrow('Write denied');
    await expect(run(write, { path: '.git/hooks/pre-push', content: 'x' })).rejects.toThrow('Write denied');
  });
});

describe('ca --agent', () => {
  it('session is read-only: no bash, edit, or write', async () => {
    const { session } = await createAgentSession({
      cwd: repo,
      agentDir: join(root, 'pi-agent'),
      sessionManager: SessionManager.inMemory(repo),
      ...orchestratorTools('/case', repo),
    });
    expect(session.getActiveToolNames().sort()).toEqual([
      'create_task',
      'fetch_issue',
      'read',
      'run_baseline',
      'run_pipeline',
    ]);
  });
});
