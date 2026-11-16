import { constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { defineTool } from './define-tool.js';
import { runCommand } from '../../util/run-command.js';
import { resolveDataDir } from '../../paths.js';
import { writablePath } from '../sandbox.js';

// Host-side tools for the credentialed steps agents can't do from sandboxed bash. Arguments are fixed;
// the model only supplies text or a validated file path, never a command line.

const MEDIA = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm'];

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: {} });

async function run(command: string, args: string[], cwd: string, timeout: number): Promise<string> {
  const result = await runCommand(command, args, { cwd, timeout });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ').slice(0, 80)} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

export function createPullRequestTool(cwd: string) {
  return defineTool({
    name: 'create_pull_request',
    label: 'Create PR',
    description:
      'Push the current feature branch to origin and open a pull request with `gh pr create`. Refuses main/master. Returns the PR URL.',
    parameters: Type.Object({
      title: Type.String({ description: 'PR title in conventional commit format' }),
      body: Type.String({ description: 'PR body markdown' }),
    }),
    execute: async (_toolCallId, { title, body }) => {
      const branch = await run('git', ['branch', '--show-current'], cwd, 30_000);
      if (!branch || branch === 'main' || branch === 'master') {
        throw new Error(`Refusing to push "${branch || 'detached HEAD'}"; switch to a feature branch.`);
      }
      // Hooks can live in the sandbox-writable working tree (e.g. husky's core.hooksPath=.husky), so never run them here.
      await run(
        'git',
        ['-c', 'core.hooksPath=/dev/null', 'push', '--no-recurse-submodules', '-u', 'origin', 'HEAD'],
        cwd,
        120_000,
      );
      return text(await run('gh', ['pr', 'create', `--title=${title}`, `--body=${body}`], cwd, 60_000));
    },
  });
}

export function createPrCommentTool(cwd: string) {
  return defineTool({
    name: 'comment_on_pull_request',
    label: 'PR comment',
    description: "Post a COMMENT review on the current branch's pull request with `gh pr review --comment`.",
    parameters: Type.Object({
      body: Type.String({ description: 'Review comment markdown' }),
    }),
    execute: async (_toolCallId, { body }) =>
      text((await run('gh', ['pr', 'review', '--comment', `--body=${body}`], cwd, 60_000)) || 'Review comment posted.'),
  });
}

export function createUploadEvidenceTool(cwd: string) {
  return defineTool({
    name: 'upload_evidence',
    label: 'Upload evidence',
    description:
      'Upload a screenshot or video from the repo or /tmp with `ca upload` and return its markdown reference for the PR.',
    parameters: Type.Object({
      path: Type.String({ description: `File inside the repo or /tmp (${MEDIA.join(', ')})` }),
    }),
    execute: async (_toolCallId, { path }) => {
      const real = writablePath(resolve(cwd, path), cwd);
      const ext = extname(real).slice(1).toLowerCase();
      if (!MEDIA.includes(ext)) throw new Error(`upload_evidence only accepts ${MEDIA.join(', ')} files`);

      // Snapshot the file where sandboxed bash can't write, so it can't be swapped for a symlink mid-upload.
      const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: Buffer;
      try {
        if (!(await file.stat()).isFile()) throw new Error(`Not a regular file: ${path}`);
        data = await file.readFile();
      } finally {
        await file.close();
      }
      // `ca upload` hands webm to ffmpeg, which content-sniffs (e.g. HLS playlists that pull in local files).
      if (ext === 'webm' && data.subarray(0, 4).toString('hex') !== '1a45dfa3') {
        throw new Error(`Not a webm video: ${path}`);
      }

      const dataDir = resolveDataDir();
      mkdirSync(dataDir, { recursive: true });
      const dir = mkdtempSync(join(dataDir, 'upload-'));
      try {
        const copy = join(dir, basename(real));
        writeFileSync(copy, data);
        return text(await run('ca', ['upload', copy], dir, 300_000));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  });
}
