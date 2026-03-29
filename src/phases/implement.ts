import { resolve } from 'node:path';
import type { AgentName, AgentResult, FailureAnalysis, PhaseOutput, PipelineConfig, RevisionRequest } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { assemblePrompt } from '../context/assembler.js';
import { prefetchRepoContext } from '../context/prefetch.js';
import { runScript } from '../util/run-script.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Step 4 + 4b: Spawn implementer, intelligent retry on failure.
 * Max 1 retry — analyze failure, adjust prompt, try once more.
 */
export async function runImplementPhase(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
  revision?: RevisionRequest,
): Promise<PhaseOutput> {
  // Update task state: implementing + agent running
  await store.setStatus('implementing');
  await store.setAgentPhase('implementer', 'status', 'running');
  await store.setAgentPhase('implementer', 'started', 'now');

  log.phase('implement', 'started');

  if (config.dryRun) {
    log.phase('implement', 'dry-run-skip');
    return dryRunResult('implement');
  }

  // Prefetch context and assemble prompt
  const task = await store.read();
  const repoContext = await prefetchRepoContext(config, 'implementer');
  const prompt = await assemblePrompt('implementer', config, task, repoContext, previousResults, revision);

  // Spawn implementer
  const { result } = await spawnAgent({
    prompt,
    cwd: config.repoPath,
    agentName: 'implementer',
    caseRoot: config.caseRoot,
    onHeartbeat: config.onAgentHeartbeat,
    traceWriter: config.traceWriter,
    phase: 'implement',
  });

  if (result.status === 'completed') {
    await store.setAgentPhase('implementer', 'status', 'completed');
    await store.setAgentPhase('implementer', 'completed', 'now');
    previousResults.set('implementer', result);
    log.phase('implement', 'completed');
    return { result, nextPhase: 'verify' };
  }

  // Failed — attempt intelligent retry (Step 4b)
  log.phase('implement', 'failed', { error: result.error });

  if (config.maxRetries > 0) {
    const retryResult = await attemptRetry(config, store, previousResults, result, prompt);
    if (retryResult) return retryResult;
  }

  // No retry or retry also failed
  await store.setAgentPhase('implementer', 'status', 'failed');
  previousResults.set('implementer', result);
  log.phase('implement', 'aborted');
  return { result, nextPhase: 'abort' };
}

async function attemptRetry(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
  originalResult: AgentResult,
  originalPrompt: string,
): Promise<PhaseOutput | null> {
  const analyzeScript = resolve(config.caseRoot, 'scripts/analyze-failure.sh');
  const analysisRun = await runScript('bash', [
    analyzeScript,
    config.taskJsonPath,
    'implementer',
    originalResult.error ?? 'unknown error',
  ]);

  if (analysisRun.exitCode !== 0) {
    log.error('failure analysis failed', { stderr: analysisRun.stderr });
    return null;
  }

  let analysis: FailureAnalysis;
  try {
    analysis = JSON.parse(analysisRun.stdout) as FailureAnalysis;
  } catch {
    log.error('failure analysis output not valid JSON');
    return null;
  }

  if (!analysis.retryViable) {
    log.phase('implement', 'retry-not-viable', { reason: analysis.suggestedFocus });
    return null;
  }

  // Build retry prompt with failure context prepended
  const retryContext = [
    '## RETRY CONTEXT — Previous attempt failed',
    '',
    `**Failure class:** ${analysis.failureClass}`,
    `**Error:** ${analysis.errorSummary}`,
    `**What was already tried:** ${analysis.whatWasTried.map((t) => `- ${t}`).join('\n')}`,
    `**Suggested focus:** ${analysis.suggestedFocus}`,
    '',
    'Do NOT repeat the previous approach. Read your working memory for details on what was tried.',
    'Focus on the suggested approach above.',
    '',
  ].join('\n');

  const retryPrompt = retryContext + originalPrompt;

  log.phase('implement', 'retrying', { failureClass: analysis.failureClass });
  const { result: retryResult } = await spawnAgent({
    prompt: retryPrompt,
    cwd: config.repoPath,
    agentName: 'implementer',
    caseRoot: config.caseRoot,
    onHeartbeat: config.onAgentHeartbeat,
    traceWriter: config.traceWriter,
    phase: 'implement',
  });

  if (retryResult.status === 'completed') {
    await store.setAgentPhase('implementer', 'status', 'completed');
    await store.setAgentPhase('implementer', 'completed', 'now');
    previousResults.set('implementer', retryResult);
    log.phase('implement', 'retry-succeeded');
    return { result: retryResult, nextPhase: 'verify' };
  }

  log.phase('implement', 'retry-failed', { error: retryResult.error });
  return null;
}

function dryRunResult(phase: string): PhaseOutput {
  return {
    result: {
      status: 'completed',
      summary: `[dry-run] ${phase} phase skipped`,
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
    nextPhase: 'verify',
  };
}
