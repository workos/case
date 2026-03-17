import type { AgentName, AgentResult, PipelineConfig, PipelinePhase } from './types.js';
import { TaskStore } from './state/task-store.js';
import { determineEntryPhase } from './state/transitions.js';
import { createNotifier, type Notifier } from './notify.js';
import { runImplementPhase } from './phases/implement.js';
import { runVerifyPhase } from './phases/verify.js';
import { runReviewPhase } from './phases/review.js';
import { runClosePhase } from './phases/close.js';
import { runRetrospectivePhase } from './phases/retrospective.js';
import { MetricsCollector } from './metrics/collector.js';
import { writeRunMetrics } from './metrics/writer.js';
import { getCurrentPromptVersions, findPriorRunId } from './versioning/prompt-tracker.js';
import { createLogger } from './util/logger.js';

const log = createLogger();

const PHASE_AGENT_MAP: Record<string, AgentName | 'retrospective'> = {
  implement: 'implementer',
  verify: 'verifier',
  review: 'reviewer',
  close: 'closer',
  retrospective: 'retrospective',
};

/**
 * Core pipeline loop — while/switch replacing SKILL.md Steps 4-9.
 *
 * Each case calls the corresponding phase module and handles success/failure
 * branching based on the pipeline mode (attended/unattended).
 */
export async function runPipeline(config: PipelineConfig): Promise<void> {
  const store = new TaskStore(config.taskJsonPath, config.caseRoot);
  const notifier = createNotifier(config.mode);
  const previousResults = new Map<AgentName, AgentResult>();
  const metrics = new MetricsCollector();

  const task = await store.read();
  let currentPhase: PipelinePhase = determineEntryPhase(task);
  let outcome: 'completed' | 'failed' = 'completed';
  let failedAgent: AgentName | undefined;

  // Load prompt versions for this run's metrics
  const promptVersions = await getCurrentPromptVersions(config.caseRoot);
  metrics.setPromptVersions(promptVersions);

  log.info('pipeline started', { phase: currentPhase, mode: config.mode, task: task.id, runId: metrics.runId });

  while (currentPhase !== 'complete' && currentPhase !== 'abort') {
    log.phase(currentPhase, 'entering');
    const phaseAgent = PHASE_AGENT_MAP[currentPhase];
    if (phaseAgent) metrics.startPhase(currentPhase, phaseAgent);

    switch (currentPhase) {
      case 'implement': {
        const output = await runImplementPhase(config, store, previousResults);
        if (output.nextPhase === 'abort') {
          metrics.endPhase('failed', config.maxRetries > 0);
          const choice = await handleFailure(notifier, config, 'implementer', output.result, [
            'Retry with guidance',
            'Abort',
          ]);
          if (choice === 'Retry with guidance') {
            // In attended mode, human can re-enter implement indefinitely.
            // Each attempt gets maxRetries intelligent retries (analyze + adjust).
            // This is by design — attended mode means the human decides when to stop.
            currentPhase = 'implement';
          } else {
            failedAgent = 'implementer';
            outcome = 'failed';
            currentPhase = 'retrospective';
          }
        } else {
          metrics.endPhase('completed');
          // Track CI first-push from implementer result
          if (output.result.artifacts.testsPassed !== null) {
            metrics.setCiFirstPush(output.result.artifacts.testsPassed);
          }
          currentPhase = output.nextPhase;
        }
        break;
      }

      case 'verify': {
        const output = await runVerifyPhase(config, store, previousResults);
        if (output.nextPhase === 'abort') {
          metrics.endPhase('failed');
          const choice = await handleFailure(notifier, config, 'verifier', output.result, [
            'Re-implement and re-verify',
            'Skip verification',
            'Abort',
          ]);
          if (choice === 'Re-implement and re-verify') {
            currentPhase = 'implement';
          } else if (choice === 'Skip verification') {
            currentPhase = 'review';
          } else {
            failedAgent = 'verifier';
            outcome = 'failed';
            currentPhase = 'retrospective';
          }
        } else {
          metrics.endPhase('completed');
          currentPhase = output.nextPhase;
        }
        break;
      }

      case 'review': {
        const output = await runReviewPhase(config, store, previousResults);
        // Capture review findings in metrics
        if (output.result.findings) {
          metrics.setReviewFindings(output.result.findings);
        }
        if (output.nextPhase === 'abort') {
          metrics.endPhase('failed');
          const choice = await handleFailure(notifier, config, 'reviewer', output.result, [
            'Re-implement and re-review',
            'Override and continue',
            'Abort',
          ]);
          if (choice === 'Re-implement and re-review') {
            currentPhase = 'implement';
          } else if (choice === 'Override and continue') {
            currentPhase = 'close';
          } else {
            failedAgent = 'reviewer';
            outcome = 'failed';
            currentPhase = 'retrospective';
          }
        } else {
          metrics.endPhase('completed');
          currentPhase = output.nextPhase;
        }
        break;
      }

      case 'close': {
        const output = await runClosePhase(config, store, previousResults);
        if (output.nextPhase === 'abort') {
          metrics.endPhase('failed');
          const choice = await handleFailure(notifier, config, 'closer', output.result, ['Retry', 'Abort']);
          if (choice === 'Retry') {
            currentPhase = 'close';
          } else {
            failedAgent = 'closer';
            outcome = 'failed';
            currentPhase = 'retrospective';
          }
        } else {
          metrics.endPhase('completed');
          const prUrl = output.result.artifacts.prUrl;
          if (prUrl) {
            notifier.send(`PR created: ${prUrl}`);
          }
          currentPhase = output.nextPhase;
        }
        break;
      }

      case 'retrospective': {
        metrics.startPhase('retrospective', 'retrospective');
        await runRetrospectivePhase(config, store, previousResults, outcome, failedAgent);
        metrics.endPhase('completed');
        currentPhase = outcome === 'completed' ? 'complete' : 'abort';
        break;
      }
    }
  }

  // Finalize and write metrics
  const runMetrics = metrics.finalize(outcome, failedAgent);
  const priorRunId = await findPriorRunId(config.caseRoot, task.id);
  await writeRunMetrics(config.caseRoot, task.id, config.repoName, runMetrics, {
    priorRunId,
    parentTaskId: task.contractPath,
  });

  log.info('pipeline finished', {
    outcome,
    failedAgent,
    runId: runMetrics.runId,
    totalDurationMs: runMetrics.totalDurationMs,
  });

  if (outcome === 'failed') {
    notifier.send(`Pipeline failed at ${failedAgent ?? 'unknown'} phase.`);
  } else {
    notifier.send('Pipeline completed successfully.');
  }
}

async function handleFailure(
  notifier: Notifier,
  config: PipelineConfig,
  agent: AgentName,
  result: AgentResult,
  options: string[],
): Promise<string> {
  const errorMsg = result.error ?? result.summary ?? 'unknown error';
  const prompt = `${agent} failed: ${errorMsg}`;

  return notifier.askUser(prompt, options);
}
