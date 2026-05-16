import type { AgentName, AgentResult, PhaseOutput, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { assemblePrompt } from '../context/assembler.js';
import { prefetchRepoContext } from '../context/prefetch.js';
import { buildRevisionRequest } from './revision.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Step 5: Spawn verifier. No retries — verification failures need human judgment.
 */
export async function runVerifyPhase(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
): Promise<PhaseOutput> {
  log.phase('verify', 'started');

  if (config.dryRun) {
    log.phase('verify', 'dry-run-skip');
    return {
      result: {
        status: 'completed',
        summary: '[dry-run] verify phase skipped',
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
      nextPhase: 'review',
    };
  }

  const task = await store.read();
  const repoContext = await prefetchRepoContext(config, 'verifier');
  const prompt = await assemblePrompt('verifier', config, task, repoContext, previousResults);

  const spawn = config.runtime?.spawn.bind(config.runtime) ?? spawnAgent;
  const { result } = await spawn({
    prompt,
    cwd: config.repoPath,
    agentName: 'verifier',
    caseRoot: config.caseRoot,
    onHeartbeat: config.onAgentHeartbeat,
    traceWriter: config.traceWriter,
    eventAppender: config.eventAppender,
    phase: 'verify',
  });

  if (result.status === 'completed') {
    previousResults.set('verifier', result);

    if (result.rubric?.role === 'verifier') {
      const fails = result.rubric.categories.filter((c) => c.verdict === 'fail');
      if (fails.length > 0) {
        const revision = buildRevisionRequest('verifier', fails);
        log.phase('verify', 'completed-with-revision', { failedCategories: fails.map((c) => c.category) });
        return { result, nextPhase: 'review', revision };
      }
    }

    log.phase('verify', 'completed');
    return { result, nextPhase: 'review' };
  }

  previousResults.set('verifier', result);
  log.phase('verify', 'failed', { error: result.error });
  return { result, nextPhase: 'abort' };
}
