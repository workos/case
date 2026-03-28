import type { AgentName, AgentResult, PhaseOutput, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { assemblePrompt } from '../context/assembler.js';
import { prefetchRepoContext } from '../context/prefetch.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Step 7: Set status to closing BEFORE spawning (matches SKILL.md).
 * Pass verifier and reviewer AGENT_RESULT to closer via context assembly.
 */
export async function runClosePhase(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
): Promise<PhaseOutput> {
  // Orchestrator sets closing — not the closer agent
  await store.setStatus('closing');
  await store.setAgentPhase('closer', 'status', 'running');
  await store.setAgentPhase('closer', 'started', 'now');

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

  const { result } = await spawnAgent({
    prompt,
    cwd: config.repoPath,
    agentName: 'closer',
    caseRoot: config.caseRoot,
    onHeartbeat: config.onAgentHeartbeat,
    traceWriter: config.traceWriter,
    phase: 'close',
  });

  if (result.status === 'completed') {
    await store.setAgentPhase('closer', 'status', 'completed');
    await store.setAgentPhase('closer', 'completed', 'now');

    // Store PR URL and number from closer's artifacts
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

  await store.setAgentPhase('closer', 'status', 'failed');
  previousResults.set('closer', result);
  log.phase('close', 'failed', { error: result.error });
  return { result, nextPhase: 'abort' };
}
