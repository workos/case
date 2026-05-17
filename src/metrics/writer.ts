import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RunMetrics } from '../types.js';
import { resolveRunLogPath } from '../paths.js';
import { ensureDataDir } from '../data-dir.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Append RunMetrics to the run log as a single JSON line.
 */
export async function writeRunMetrics(
  caseRoot: string,
  taskId: string,
  repo: string,
  metrics: RunMetrics,
  extra?: {
    priorRunId?: string | null;
    parentTaskId?: string | null;
  },
): Promise<void> {
  // Phase 3: prefer the dataDir path. Back-compat: if dataDir log is absent
  // but a legacy `<caseRoot>/docs/run-log.jsonl` exists, keep appending there
  // so we don't split the history mid-transition.
  ensureDataDir();
  const dataDirLog = resolveRunLogPath();
  const legacyLog = resolve(caseRoot, 'docs/run-log.jsonl');
  let logFile = dataDirLog;
  if (!(await Bun.file(dataDirLog).exists()) && (await Bun.file(legacyLog).exists())) {
    logFile = legacyLog;
  }

  const entry = {
    runId: metrics.runId,
    date: new Date().toISOString().slice(0, 10),
    task: taskId,
    repo,
    outcome: metrics.outcome,
    failedAgent: metrics.failedAgent ?? null,
    phases: Object.fromEntries(metrics.phases.map((p) => [p.agent, p.status])),
    promptVersions: Object.keys(metrics.promptVersions).length > 0 ? metrics.promptVersions : null,
    priorRunId: extra?.priorRunId ?? null,
    parentTaskId: extra?.parentTaskId ?? null,
    metrics: {
      totalDurationMs: metrics.totalDurationMs,
      ciFirstPush: metrics.ciFirstPush,
      reviewFindings: metrics.reviewFindings
        ? {
            critical: metrics.reviewFindings.critical,
            warnings: metrics.reviewFindings.warnings,
            info: metrics.reviewFindings.info,
          }
        : null,
      phaseDurations: Object.fromEntries(metrics.phases.map((p) => [p.agent, p.durationMs])),
      profile: metrics.profile,
      revisionCycles: metrics.revisionCycles,
      humanOverrides: metrics.humanOverrides,
      evaluatorEffectiveness: metrics.evaluatorEffectiveness,
    },
  };

  await mkdir(dirname(logFile), { recursive: true });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(logFile, JSON.stringify(entry) + '\n');

  log.info('run metrics written', { runId: metrics.runId, outcome: metrics.outcome });
}
