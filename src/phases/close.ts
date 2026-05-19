import type { AgentName, AgentResult, PhaseOutcome, PhaseOutput, PipelineConfig } from '../types.js';
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
      outcome: { phase: 'close', outcome: 'success', details: 'dry-run' },
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
    packageRoot: config.packageRoot,
    dataDir: config.dataDir,
    onHeartbeat: config.onAgentHeartbeat,
    onToolActivity: config.onToolActivity,
    traceWriter: config.traceWriter,
    eventAppender: config.eventAppender,
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
    return {
      result,
      nextPhase: 'retrospective',
      outcome: { phase: 'close', outcome: 'success' },
    };
  }

  previousResults.set('closer', result);
  log.phase('close', 'failed', { error: result.error });
  return {
    result,
    nextPhase: 'abort',
    outcome: classifyCloseFailure(result),
  };
}

/**
 * Translate a closer failure into a typed outcome. The matrix routes
 * `fail-github-unreachable` to a single retry; other failures bubble up as
 * `surface` so a human can verify whether a partial PR exists.
 */
function classifyCloseFailure(result: AgentResult): PhaseOutcome {
  const err = (result.error ?? '').toLowerCase();
  if (err.includes('github') || err.includes('gh ') || err.includes('rate limit') || err.includes('network')) {
    return { phase: 'close', outcome: 'fail-github-unreachable', details: result.error ?? undefined };
  }
  if (err.includes('timeout') || err.includes('timed out')) {
    return { phase: 'close', outcome: 'fail-timeout', details: result.error ?? undefined };
  }
  return { phase: 'close', outcome: 'fail-agent-protocol', details: result.error ?? undefined };
}
