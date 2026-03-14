import { resolve } from 'node:path';
import { createLogger } from '../util/logger.js';

const log = createLogger();

interface ChangelogEntry {
  version: string;
  agent: string;
  date: string;
  task: string;
  reason: string;
  contentHash: string;
}

/**
 * Read the agent-versions changelog and return the latest prompt version per agent.
 * Returns an empty record if no changelog exists or on parse errors.
 */
export async function getCurrentPromptVersions(caseRoot: string): Promise<Record<string, string>> {
  const changelogPath = resolve(caseRoot, 'docs/agent-versions/changelog.jsonl');
  const file = Bun.file(changelogPath);

  if (!(await file.exists())) return {};

  const raw = await file.text();
  const versions: Record<string, string> = {};

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ChangelogEntry;
      if (entry.agent && entry.version) {
        versions[entry.agent] = entry.version;
      }
    } catch {
      log.error('invalid changelog line', { line: line.slice(0, 100) });
    }
  }

  return versions;
}

/**
 * Find the most recent runId for a given task in the run log.
 * Used to link runs for the same task.
 */
export async function findPriorRunId(caseRoot: string, taskId: string): Promise<string | null> {
  const logPath = resolve(caseRoot, 'docs/run-log.jsonl');
  const file = Bun.file(logPath);

  if (!(await file.exists())) return null;

  const raw = await file.text();
  let priorRunId: string | null = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { task: string; runId: string };
      if (entry.task === taskId) {
        priorRunId = entry.runId;
      }
    } catch {
      // skip malformed lines
    }
  }

  return priorRunId;
}
