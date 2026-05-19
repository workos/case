import { resolve } from 'node:path';
import type {
  AgentName,
  AgentResult,
  FailureAnalysis,
  PhaseOutcome,
  PhaseOutput,
  PipelineConfig,
  RevisionRequest,
  ScoutFindings,
} from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { assemblePrompt } from '../context/assembler.js';
import { prefetchRepoContext } from '../context/prefetch.js';
import { analyzeFailure } from '../commands/analyze-failure.js';
import { readWorkingMemory } from '../memory/working-memory.js';
import { formatForImplementer, taskSlugFromTaskJsonPath } from '../memory/format.js';
import { synthesizeForImplementer } from '../scout/findings.js';
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
  scoutFindings?: ScoutFindings | null,
): Promise<PhaseOutput> {
  log.phase('implement', 'started');

  if (config.dryRun) {
    log.phase('implement', 'dry-run-skip');
    return dryRunResult('implement');
  }

  const task = await store.read();
  const repoContext = await prefetchRepoContext(config, 'implementer');
  const basePrompt = await assemblePrompt('implementer', config, task, repoContext, previousResults, revision);
  const withMemory = prependWorkingMemory(basePrompt, config);
  const prompt = prependScoutFindings(withMemory, scoutFindings);

  const spawn = config.runtime?.spawn.bind(config.runtime) ?? spawnAgent;
  const { result } = await spawn({
    prompt,
    cwd: config.repoPath,
    agentName: 'implementer',
    packageRoot: config.packageRoot,
    dataDir: config.dataDir,
    onHeartbeat: config.onAgentHeartbeat,
    onToolActivity: config.onToolActivity,
    traceWriter: config.traceWriter,
    eventAppender: config.eventAppender,
    phase: 'implement',
  });

  if (result.status === 'completed') {
    previousResults.set('implementer', result);
    log.phase('implement', 'completed');
    const outcome: PhaseOutcome = { phase: 'implement', outcome: 'success' };
    return { result, nextPhase: 'verify', outcome };
  }

  log.phase('implement', 'failed', { error: result.error });

  if (config.maxRetries > 0) {
    const retryResult = await attemptRetry(config, store, previousResults, result, prompt);
    if (retryResult) return retryResult;
  }

  previousResults.set('implementer', result);
  log.phase('implement', 'aborted');
  return {
    result,
    nextPhase: 'abort',
    outcome: classifyImplementFailure(result),
  };
}

/**
 * Map an `AgentResult.error` string into a typed `PhaseOutcome`. The matrix
 * accepts `fail-test | fail-type-error | fail-lint | fail-build |
 * fail-timeout | fail-agent-protocol` for implement; unknown errors fall
 * back to `fail-agent-protocol` so the executor still has a defined route.
 */
function classifyImplementFailure(result: AgentResult): PhaseOutcome {
  const err = (result.error ?? result.summary ?? '').toLowerCase();
  if (!err) return { phase: 'implement', outcome: 'fail-agent-protocol' };
  if (err.includes('timeout') || err.includes('timed out')) {
    return { phase: 'implement', outcome: 'fail-timeout', details: result.error ?? undefined };
  }
  if (err.includes('type') && err.includes('error')) {
    return { phase: 'implement', outcome: 'fail-type-error', details: result.error ?? undefined };
  }
  if (err.includes('lint') || err.includes('eslint')) {
    return { phase: 'implement', outcome: 'fail-lint', details: result.error ?? undefined };
  }
  if (err.includes('build')) {
    return { phase: 'implement', outcome: 'fail-build', details: result.error ?? undefined };
  }
  if (err.includes('test')) {
    return { phase: 'implement', outcome: 'fail-test', details: result.error ?? undefined };
  }
  return { phase: 'implement', outcome: 'fail-agent-protocol', details: result.error ?? undefined };
}

async function attemptRetry(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
  originalResult: AgentResult,
  originalPrompt: string,
): Promise<PhaseOutput | null> {
  let analysis: FailureAnalysis;
  try {
    analysis = await analyzeFailure(config.taskJsonPath, 'implementer', originalResult.error ?? 'unknown error');
  } catch (err: unknown) {
    log.error('failure analysis failed', { error: (err as Error).message });
    return null;
  }

  if (!analysis.retryViable) {
    log.phase('implement', 'retry-not-viable', { reason: analysis.suggestedFocus });
    return null;
  }

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
  const spawn = config.runtime?.spawn.bind(config.runtime) ?? spawnAgent;
  const { result: retryResult } = await spawn({
    prompt: retryPrompt,
    cwd: config.repoPath,
    agentName: 'implementer',
    packageRoot: config.packageRoot,
    dataDir: config.dataDir,
    onHeartbeat: config.onAgentHeartbeat,
    onToolActivity: config.onToolActivity,
    traceWriter: config.traceWriter,
    eventAppender: config.eventAppender,
    phase: 'implement',
  });

  if (retryResult.status === 'completed') {
    previousResults.set('implementer', retryResult);
    log.phase('implement', 'retry-succeeded');
    return {
      result: retryResult,
      nextPhase: 'verify',
      outcome: { phase: 'implement', outcome: 'success' },
    };
  }

  log.phase('implement', 'retry-failed', { error: retryResult.error });
  return null;
}

/**
 * Read structured working memory (if present) and prepend it as a `## Prior
 * Context` section. Returns `basePrompt` unchanged on cold start. Falls back
 * silently on read errors — the legacy `working.md` injected by the assembler
 * still covers the no-memory case until agents adopt `ca update-memory`.
 */
function prependWorkingMemory(basePrompt: string, config: PipelineConfig): string {
  const slug = taskSlugFromTaskJsonPath(config.taskJsonPath);
  const taskDir = resolve(config.repoPath, '.case', slug);
  const memory = readWorkingMemory(taskDir);
  if (!memory) return basePrompt;
  return formatForImplementer(memory) + '\n' + basePrompt;
}

/**
 * Prepend the synthesized scout-findings block when scout produced findings.
 * Slots in **after** working memory (so prior-context still leads the prompt
 * on revision cycles) and **before** the implementer template's numbered
 * workflow. When `scoutFindings` is `null` or `undefined`, the prompt is
 * returned unchanged — backwards-compatible with the tiny profile and with
 * scout failures.
 */
function prependScoutFindings(basePrompt: string, scoutFindings?: ScoutFindings | null): string {
  if (!scoutFindings) return basePrompt;
  const block = synthesizeForImplementer(scoutFindings);
  return `${block}\n\n${basePrompt}`;
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
    outcome: { phase: 'implement', outcome: 'success', details: 'dry-run' },
  };
}
