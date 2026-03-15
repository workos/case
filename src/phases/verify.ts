import type { AgentName, AgentResult, PhaseOutput, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent-runner.js';
import { assemblePrompt } from '../context/assembler.js';
import { prefetchRepoContext } from '../context/prefetch.js';
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
  await store.setStatus('verifying');
  await store.setAgentPhase('verifier', 'status', 'running');
  await store.setAgentPhase('verifier', 'started', 'now');

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

  const { result } = await spawnAgent({
    prompt,
    cwd: config.repoPath,
    agentName: 'verifier',
    caseRoot: config.caseRoot,
  });

  if (result.status === 'completed') {
    await store.setAgentPhase('verifier', 'status', 'completed');
    await store.setAgentPhase('verifier', 'completed', 'now');
    previousResults.set('verifier', result);
    log.phase('verify', 'completed');
    return { result, nextPhase: 'review' };
  }

  await store.setAgentPhase('verifier', 'status', 'failed');
  previousResults.set('verifier', result);
  log.phase('verify', 'failed', { error: result.error });
  return { result, nextPhase: 'abort' };
}
