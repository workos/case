import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The user's real Pi config dirs, which hold credentials (auth.json, models.json) and must stay hidden from agents. */
export const realAgentDirs = new Set<string>();

/**
 * Create a fresh pi config directory for an isolated session and link the
 * user's pi auth.json into it so the session can still reach its models.
 *
 * mkdtemp picks an unpredictable name and creates the directory with mode
 * 0700, so another user sharing the temp directory cannot create or fill it
 * first (pi loads extensions and settings from this directory).
 */
export function createIsolatedAgentDir(prefix: string, realAgentDir: string): string {
  // Record before PI_CODING_AGENT_DIR is pointed at the isolated dir, so a custom location stays hidden.
  realAgentDirs.add(realAgentDir);
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
