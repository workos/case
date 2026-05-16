import type { AgentName, AgentResult, PhaseOutput, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { assemblePrompt } from '../context/assembler.js';
import { prefetchRepoContext } from '../context/prefetch.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Step 7: Spawn closer to create PR.
 * Status is managed by pipeline events — closer just runs the agent.
 */
export async function runClosePhase(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
): Promise<PhaseOutput> {
  log.phase('close', 'started');

  if (config.dryRun) {
    log.phase('close', 'dry-run-skip');
    return {
      result: {
        status: 'completed',
        summary: '[dry-run] close phase skipped',
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
      nextPhase: 'retrospective',
    };
  }

  const task = await store.read();
  const repoContext = await prefetchRepoContext(config, 'closer');
  const prompt = await assemblePrompt('closer', config, task, repoContext, previousResults);

  const spawn = config.runtime?.spawn.bind(config.runtime) ?? spawnAgent;
  const { result } = await spawn({
    prompt,
    cwd: config.repoPath,
    agentName: 'closer',
    caseRoot: config.caseRoot,
    onHeartbeat: config.onAgentHeartbeat,
    traceWriter: config.traceWriter,
    phase: 'close',
  });

  if (result.status === 'completed') {
    if (result.artifacts.prUrl) {
      await store.setField('prUrl', result.artifacts.prUrl);
    }
    if (result.artifacts.prNumber) {
      await store.setField('prNumber', String(result.artifacts.prNumber));
    }

    previousResults.set('closer', result);
    log.phase('close', 'completed', { prUrl: result.artifacts.prUrl });
    return { result, nextPhase: 'retrospective' };
  }

  previousResults.set('closer', result);
  log.phase('close', 'failed', { error: result.error });
  return { result, nextPhase: 'abort' };
}
