import type { AgentName, AgentResult, PhaseOutcome, PhaseOutput, PipelineConfig } from '../types.js';
import { REVIEWER_HARD_CATEGORIES, REVIEWER_SOFT_CATEGORIES } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { assemblePrompt } from '../context/assembler.js';
import { prefetchRepoContext } from '../context/prefetch.js';
import { buildRevisionRequest } from './revision.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Step 6: Spawn reviewer. If critical findings exist, returns abort
 * (pipeline handles attended vs unattended behavior).
 */
export async function runReviewPhase(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
): Promise<PhaseOutput> {
  log.phase('review', 'started');

  if (config.dryRun) {
    log.phase('review', 'dry-run-skip');
    return {
      result: {
        status: 'completed',
        summary: '[dry-run] review phase skipped',
        artifacts: {
          commit: null,
          filesChanged: [],
          testsPassed: null,
          screenshotUrls: [],
          evidenceMarkers: [],
          prUrl: null,
          prNumber: null,
        },
        error: null,
      },
      nextPhase: 'close',
      outcome: { phase: 'review', outcome: 'success', details: 'dry-run' },
    };
  }

  const task = await store.read();
  const repoContext = await prefetchRepoContext(config, 'reviewer');
  const prompt = await assemblePrompt('reviewer', config, task, repoContext, previousResults);

  const spawn = config.runtime?.spawn.bind(config.runtime) ?? spawnAgent;
  const { result } = await spawn({
    prompt,
    cwd: config.repoPath,
    agentName: 'reviewer',
    packageRoot: config.packageRoot,
    dataDir: config.dataDir,
    onHeartbeat: config.onAgentHeartbeat,
    onToolActivity: config.onToolActivity,
    traceWriter: config.traceWriter,
    eventAppender: config.eventAppender,
    phase: 'review',
  });

  previousResults.set('reviewer', result);

  if (result.rubric?.role === 'reviewer') {
    const hardCategories = new Set<string>(REVIEWER_HARD_CATEGORIES);
    const hardFails = result.rubric.categories.filter((c) => hardCategories.has(c.category) && c.verdict === 'fail');
    if (hardFails.length > 0) {
      log.phase('review', 'rubric-hard-fail', { categories: hardFails.map((c) => c.category) });
      const outcome: PhaseOutcome = {
        phase: 'review',
        outcome: 'fail-critical-findings',
        details: `hard rubric fail: ${hardFails.map((c) => c.category).join(', ')}`,
      };
      return { result, nextPhase: 'abort', outcome };
    }
  }

  if (result.findings && result.findings.critical > 0) {
    log.phase('review', 'critical-findings', { critical: result.findings.critical });
    return {
      result,
      nextPhase: 'abort',
      outcome: {
        phase: 'review',
        outcome: 'fail-critical-findings',
        details: `${result.findings.critical} critical finding(s)`,
      },
    };
  }

  if (result.status !== 'completed' && result.status !== 'blocked') {
    log.phase('review', 'failed', { error: result.error });
    return {
      result,
      nextPhase: 'abort',
      outcome: classifyReviewAgentFailure(result),
    };
  }

  if (result.rubric?.role === 'reviewer') {
    const softCategories = new Set<string>(REVIEWER_SOFT_CATEGORIES);
    const softFails = result.rubric.categories.filter((c) => softCategories.has(c.category) && c.verdict === 'fail');
    if (softFails.length > 0) {
      const revision = buildRevisionRequest('reviewer', softFails);
      log.phase('review', 'completed-with-revision', { softFails: softFails.map((c) => c.category) });
      return {
        result,
        nextPhase: 'close',
        revision,
        outcome: {
          phase: 'review',
          outcome: 'fail-soft-findings',
          details: softFails.map((c) => c.category).join(', '),
        },
      };
    }
  }

  log.phase('review', 'completed');
  return {
    result,
    nextPhase: 'close',
    outcome: { phase: 'review', outcome: 'success' },
  };
}

/** Translate a hard reviewer-agent failure into a typed outcome. */
function classifyReviewAgentFailure(result: AgentResult): PhaseOutcome {
  const err = (result.error ?? '').toLowerCase();
  if (err.includes('timeout') || err.includes('timed out')) {
    return { phase: 'review', outcome: 'fail-timeout', details: result.error ?? undefined };
  }
  return { phase: 'review', outcome: 'fail-agent-protocol', details: result.error ?? undefined };
}
