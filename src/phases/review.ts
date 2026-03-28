import type { AgentName, AgentResult, PhaseOutput, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { assemblePrompt } from '../context/assembler.js';
import { prefetchRepoContext } from '../context/prefetch.js';
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
  await store.setStatus('reviewing');
  await store.setAgentPhase('reviewer', 'status', 'running');
  await store.setAgentPhase('reviewer', 'started', 'now');

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
    };
  }

  const task = await store.read();
  const repoContext = await prefetchRepoContext(config, 'reviewer');
  const prompt = await assemblePrompt('reviewer', config, task, repoContext, previousResults);

  const { result } = await spawnAgent({
    prompt,
    cwd: config.repoPath,
    agentName: 'reviewer',
    caseRoot: config.caseRoot,
    onHeartbeat: config.onAgentHeartbeat,
    traceWriter: config.traceWriter,
    phase: 'review',
  });

  await store.setAgentPhase(
    'reviewer',
    'status',
    result.status === 'blocked' ? 'completed' : result.status === 'completed' ? 'completed' : 'failed',
  );
  await store.setAgentPhase('reviewer', 'completed', 'now');
  previousResults.set('reviewer', result);

  // Rubric hard-category fails → abort
  if (result.rubric?.role === 'reviewer') {
    const hardFails = result.rubric.categories.filter(
      (c) => (c.category === 'principle-compliance' || c.category === 'scope-discipline') && c.verdict === 'fail',
    );
    if (hardFails.length > 0) {
      log.phase('review', 'rubric-hard-fail', { categories: hardFails.map((c) => c.category) });
      return { result, nextPhase: 'abort' };
    }
  }

  // Critical findings → abort (pipeline decides attended/unattended behavior)
  if (result.findings && result.findings.critical > 0) {
    log.phase('review', 'critical-findings', { critical: result.findings.critical });
    return { result, nextPhase: 'abort' };
  }

  if (result.status === 'completed' || result.status === 'blocked') {
    log.phase('review', 'completed');
    return { result, nextPhase: 'close' };
  }

  log.phase('review', 'failed', { error: result.error });
  return { result, nextPhase: 'abort' };
}
