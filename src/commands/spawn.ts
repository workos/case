/**
 * Shared script-spawn helper for `case` subcommands that wrap shell scripts.
 *
 * Single source of truth for invoking a packaged script:
 *   1. Resolve via Phase 1's `resolveScript()` so the script ships from packageRoot.
 *   2. Validate existence — throw with the full attempted path on ENOENT.
 *   3. Validate executable bit — auto-`chmod 755` once on EACCES, then retry.
 *   4. Spawn with stdio inheritance so stdin (for mark-tested), stdout, and
 *      stderr pass through transparently.
 *   5. Return the exit code (default 1 if the child was signal-killed).
 */

import fs from 'node:fs';
import { resolveScript } from '../paths.js';

export interface SpawnOptions {
  cwd?: string;
}

/**
 * Resolve and spawn a packaged script, forwarding stdio and returning the exit code.
 *
 * @throws Error("Script not found: <name> (tried <path>)") if the resolved path is missing.
 * @throws Error wrapping fs.accessSync if the executable bit cannot be set.
 */
export async function spawnScript(
  name: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<number> {
  const path = resolveScript(name);

  if (!fs.existsSync(path)) {
    throw new Error(`Script not found: ${name} (tried ${path})`);
  }

  try {
    fs.accessSync(path, fs.constants.X_OK);
  } catch {
    fs.chmodSync(path, 0o755);
    // Re-check; if still not executable, this throws and surfaces to caller.
    fs.accessSync(path, fs.constants.X_OK);
  }

  const proc = Bun.spawn([path, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: opts.cwd,
  });

  const code = await proc.exited;
  return typeof code === 'number' ? code : 1;
}
