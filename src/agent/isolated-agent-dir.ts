import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a fresh pi config directory for an isolated session and link the
 * user's pi auth.json into it so the session can still reach its models.
 *
 * mkdtemp picks an unpredictable name and creates the directory with mode
 * 0700, so another user sharing the temp directory cannot create or fill it
 * first (pi loads extensions and settings from this directory).
 */
export function createIsolatedAgentDir(prefix: string, realAgentDir: string): string {
  const base = tmpdir();
  // mkdtemp needs an existing parent, and TMPDIR may name one that does not exist yet.
  mkdirSync(base, { recursive: true });
  const agentDir = mkdtempSync(join(base, prefix));
  const realAuth = join(realAgentDir, 'auth.json');
  if (existsSync(realAuth)) {
    symlinkSync(realAuth, join(agentDir, 'auth.json'));
  }
  return agentDir;
}
