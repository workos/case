import { join, resolve } from 'node:path';
import { parseJsonLines } from '../util/parse-jsonl.js';
import { resolveAgentVersionsDir, resolveRunLogPath } from '../paths.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

interface ChangelogEntry {
  version: string;
  agent: string;
}

interface RunLogEntry {
  task: string;
  runId: string;
}

/**
 * Resolve a state file by trying the dataDir path first and falling back to a
 * legacy in-repo path if only the legacy exists. Lets the codebase keep working
 * during the transition from in-repo state to `~/.config/case/`.
 */
async function resolveReadPath(dataDirPath: string, legacy: string): Promise<string | null> {
  if (await Bun.file(dataDirPath).exists()) return dataDirPath;
  if (await Bun.file(legacy).exists()) return legacy;
  return null;
}

/**
 * Read the agent-versions changelog and return the latest prompt version per agent.
 * Returns an empty record if no changelog exists or on parse errors.
 */
export async function getCurrentPromptVersions(caseRoot: string): Promise<Record<string, string>> {
  const dataDirPath = join(resolveAgentVersionsDir(), 'changelog.jsonl');
  const legacy = resolve(caseRoot, 'docs/agent-versions/changelog.jsonl');
  const path = await resolveReadPath(dataDirPath, legacy);
  if (!path) return {};
  return parseChangelog(await Bun.file(path).text());
}

function parseChangelog(text: string): Record<string, string> {
  const entries = parseJsonLines<ChangelogEntry>(text, (line) => {
    log.error('invalid changelog line', { line: line.slice(0, 100) });
  });
  const versions: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.agent && entry.version) {
      versions[entry.agent] = entry.version;
    }
  }
  return versions;
}

/**
 * Find the most recent runId for a given task in the run log.
 */
export async function findPriorRunId(caseRoot: string, taskId: string): Promise<string | null> {
  const dataDirPath = resolveRunLogPath();
  const legacy = resolve(caseRoot, 'docs/run-log.jsonl');
  const path = await resolveReadPath(dataDirPath, legacy);
  if (!path) return null;

  const entries = parseJsonLines<RunLogEntry>(await Bun.file(path).text());
  let priorRunId: string | null = null;
  for (const entry of entries) {
    if (entry.task === taskId) {
      priorRunId = entry.runId;
    }
  }
  return priorRunId;
}
