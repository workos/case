/**
 * LangChain agent tools — the working-tree primitives the {@link LangChainRuntime}
 * hands to `createReactAgent` for non-Claude models. pi's `createReadTool` etc.
 * are pi-specific and cannot be reused, so these reimplement the same four
 * primitives (Read / Bash / Edit / Write) as LangChain `tool()`s bound to a cwd.
 *
 * Parity with pi / the Agent SDK is enforced by {@link toolPolicyFor}: read-only
 * roles get Read + Bash only; mutable roles additionally get Write + Edit. Read
 * and Bash are the exploration surface (Bash runs `rg`/`find`); withholding
 * Write/Edit is what makes a role read-only — identical to the pi adapter.
 */
import { tool } from '@langchain/core/tools';
// Namespace import: Vitest's module resolver mishandles zod v4's export map and
// yields `undefined` for the named `z` binding. `import * as z` is robust under
// both the Bun runtime and the Vite/Vitest transform.
import * as z from 'zod';
import { exec } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { toolPolicyFor } from '../../config.js';

const execAsync = promisify(exec);

const MAX_READ_BYTES = 100_000;
const MAX_BASH_BUFFER = 1_000_000;
const BASH_TIMEOUT_MS = 120_000;

/** Resolve an agent-supplied path against the workspace cwd. */
function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function createReadTool(cwd: string) {
  return tool(
    async ({ path }: { path: string }) => {
      const content = await readFile(resolvePath(cwd, path), 'utf8');
      return content.length > MAX_READ_BYTES
        ? `${content.slice(0, MAX_READ_BYTES)}\n…[truncated at ${MAX_READ_BYTES} bytes]`
        : content;
    },
    {
      name: 'read',
      description: 'Read a file from the workspace. Path is relative to the repo root.',
      schema: z.object({ path: z.string().describe('File path relative to the repo root') }),
    },
  );
}

function createBashTool(cwd: string) {
  return tool(
    async ({ command }: { command: string }) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          maxBuffer: MAX_BASH_BUFFER,
          timeout: BASH_TIMEOUT_MS,
        });
        return stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout || '(no output)';
      } catch (e) {
        // Surface non-zero exits to the agent as tool output, not a thrown error
        // (a failed command is information the agent should react to, not a crash).
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return `Command failed: ${err.message ?? 'unknown error'}\n${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
    },
    {
      name: 'bash',
      description: 'Run a shell command in the workspace (e.g. rg, find, ls, git, tests).',
      schema: z.object({ command: z.string().describe('Shell command to execute') }),
    },
  );
}

function createWriteTool(cwd: string) {
  return tool(
    async ({ path, content }: { path: string; content: string }) => {
      await writeFile(resolvePath(cwd, path), content, 'utf8');
      return `Wrote ${content.length} bytes to ${path}`;
    },
    {
      name: 'write',
      description: 'Create or overwrite a file with the given content.',
      schema: z.object({
        path: z.string().describe('File path relative to the repo root'),
        content: z.string().describe('Full file content to write'),
      }),
    },
  );
}

function createEditTool(cwd: string) {
  return tool(
    async ({
      path,
      old_string,
      new_string,
      replace_all,
    }: {
      path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }) => {
      const abs = resolvePath(cwd, path);
      const original = await readFile(abs, 'utf8');
      if (!original.includes(old_string)) {
        return `Edit failed: old_string not found in ${path}`;
      }
      const occurrences = original.split(old_string).length - 1;
      if (!replace_all && occurrences > 1) {
        return `Edit failed: old_string is not unique in ${path} (${occurrences} matches). Pass replace_all or add context.`;
      }
      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.replace(old_string, new_string);
      await writeFile(abs, updated, 'utf8');
      return `Edited ${path} (${replace_all ? occurrences : 1} replacement${replace_all && occurrences > 1 ? 's' : ''})`;
    },
    {
      name: 'edit',
      description:
        'Replace an exact string in a file. Fails if old_string is missing or non-unique (unless replace_all).',
      schema: z.object({
        path: z.string().describe('File path relative to the repo root'),
        old_string: z.string().describe('Exact text to replace'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
      }),
    },
  );
}

/**
 * Build the LangChain tool array for an agent, gated by {@link toolPolicyFor}.
 * read-only → [read, bash]; mutable → [read, bash, write, edit].
 */
export function createLangchainTools(agentName: string, cwd: string) {
  const base = [createReadTool(cwd), createBashTool(cwd)];
  return toolPolicyFor(agentName) === 'mutable' ? [...base, createWriteTool(cwd), createEditTool(cwd)] : base;
}
