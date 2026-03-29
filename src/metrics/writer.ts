import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { RunMetrics } from '../types.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Append RunMetrics to the run log as a single JSON line.
 * Replaces the Python-based log-run.sh for metrics written by the orchestrator.
 * log-run.sh still handles relational fields (priorRunId, parentTaskId).
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
  const logFile = resolve(caseRoot, 'docs/run-log.jsonl');

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
      approvalDecision: metrics.approvalDecision,
      approvalTimeMs: metrics.approvalTimeMs,
      humanRevisionCycles: metrics.humanRevisionCycles,
      evaluatorEffectiveness: metrics.evaluatorEffectiveness,
    },
  };

  await mkdir(dirname(logFile), { recursive: true });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(logFile, JSON.stringify(entry) + '\n');

  log.info('run metrics written', { runId: metrics.runId, outcome: metrics.outcome });
}
