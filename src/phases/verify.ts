import { resolve } from 'node:path';
import type { AgentName, AgentResult, PhaseOutcome, PhaseOutput, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { assemblePrompt } from '../context/assembler.js';
import { prefetchRepoContext } from '../context/prefetch.js';
import { buildRevisionRequest } from './revision.js';
import { readWorkingMemory } from '../memory/working-memory.js';
import { formatForVerifier, taskSlugFromTaskJsonPath } from '../memory/format.js';
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
      outcome: { phase: 'verify', outcome: 'success', details: 'dry-run' },
    };
  }

  const task = await store.read();
  const repoContext = await prefetchRepoContext(config, 'verifier');
  const basePrompt = await assemblePrompt('verifier', config, task, repoContext, previousResults);
  const prompt = prependWorkingMemory(basePrompt, config);

  const spawn = config.runtime?.spawn.bind(config.runtime) ?? spawnAgent;
  const { result } = await spawn({
    prompt,
    cwd: config.repoPath,
    agentName: 'verifier',
    packageRoot: config.packageRoot,
    dataDir: config.dataDir,
    onHeartbeat: config.onAgentHeartbeat,
    onToolActivity: config.onToolActivity,
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
        const outcome: PhaseOutcome = classifyVerifierFailure(fails);
        return { result, nextPhase: 'review', revision, outcome };
      }
    }

    log.phase('verify', 'completed');
    return {
      result,
      nextPhase: 'review',
      outcome: { phase: 'verify', outcome: 'success' },
    };
  }

  previousResults.set('verifier', result);
  log.phase('verify', 'failed', { error: result.error });
  return {
    result,
    nextPhase: 'abort',
    outcome: classifyVerifyAgentFailure(result),
  };
}

/**
 * Choose between `fail-test`, `fail-evidence-missing`, and `fail-soft-findings`
 * based on which rubric category failed. Verifier categories include
 * `reproduced-scenario`, `exercised-changed-path`, `evidence-proves-change`,
 * and `edge-case-checked` — the first three map to behavioural failures, and
 * we treat `evidence-proves-change` as the evidence-missing signal.
 */
function classifyVerifierFailure(fails: Array<{ category: string; detail: string }>): PhaseOutcome {
  const categories = fails.map((c) => c.category);
  if (categories.includes('evidence-proves-change')) {
    return { phase: 'verify', outcome: 'fail-evidence-missing', details: fails[0]?.detail };
  }
  if (categories.includes('reproduced-scenario') || categories.includes('exercised-changed-path')) {
    return { phase: 'verify', outcome: 'fail-test', details: fails[0]?.detail };
  }
  return { phase: 'verify', outcome: 'fail-soft-findings', details: fails[0]?.detail };
}

/**
 * Read structured working memory (if present) and prepend a concise context
 * section so the verifier inherits the implementer's approach + files. Cold
 * start returns the base prompt unchanged.
 */
function prependWorkingMemory(basePrompt: string, config: PipelineConfig): string {
  const slug = taskSlugFromTaskJsonPath(config.taskJsonPath);
  const taskDir = resolve(config.repoPath, '.case', slug);
  const memory = readWorkingMemory(taskDir);
  if (!memory) return basePrompt;
  return formatForVerifier(memory) + '\n' + basePrompt;
}

/** Translate a hard verifier-agent failure into a typed outcome. */
function classifyVerifyAgentFailure(result: AgentResult): PhaseOutcome {
  const err = (result.error ?? '').toLowerCase();
  if (err.includes('timeout') || err.includes('timed out')) {
    return { phase: 'verify', outcome: 'fail-timeout', details: result.error ?? undefined };
  }
  return { phase: 'verify', outcome: 'fail-agent-protocol', details: result.error ?? undefined };
}
