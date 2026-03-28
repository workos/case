import type { AgentName, AgentResult, PipelineConfig, PipelinePhase, PipelineProfile, RevisionRequest } from './types.js';
import { PROFILE_PHASES } from './types.js';
import { TaskStore } from './state/task-store.js';
import { determineEntryPhase, findNextAllowedPhase } from './state/transitions.js';
import { createNotifier, formatDuration, type Notifier } from './notify.js';
import { runImplementPhase } from './phases/implement.js';
import { runVerifyPhase } from './phases/verify.js';
import { runReviewPhase } from './phases/review.js';
import { runClosePhase } from './phases/close.js';
import { runRetrospectivePhase } from './phases/retrospective.js';
import { MetricsCollector } from './metrics/collector.js';
import { writeRunMetrics } from './metrics/writer.js';
import { getCurrentPromptVersions, findPriorRunId } from './versioning/prompt-tracker.js';
import { TraceWriter } from './tracing/writer.js';
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

  // Wire up heartbeat: phases pass this to spawnAgent, which fires it every 30s
  config.onAgentHeartbeat = (elapsedMs) => {
    notifier.send(`  ... still running (${formatDuration(elapsedMs)})`);
  };

  const task = await store.read();
  const profile = task.profile ?? 'standard';
  const allowedPhases = new Set(PROFILE_PHASES[profile]);
  let currentPhase: PipelinePhase = determineEntryPhase(task, profile);
  let outcome: 'completed' | 'failed' = 'completed';
  let failedAgent: AgentName | undefined;
  let revisionCycles = 0;
  let pendingRevision: RevisionRequest | null = null;
  const maxRevisionCycles = config.maxRevisionCycles ?? 2;

  // Per-run trace writer for tool-level observability
  const traceWriter = new TraceWriter(config.caseRoot, task.id, metrics.runId);
  config.traceWriter = traceWriter;

  // Track pipeline profile
  metrics.setProfile(profile);

  // Load prompt versions for this run's metrics
  const promptVersions = await getCurrentPromptVersions(config.caseRoot);
  metrics.setPromptVersions(promptVersions);

  log.info('pipeline started', { phase: currentPhase, mode: config.mode, task: task.id, runId: metrics.runId });

  /** Handle the revision/budget-exhausted/clean-pass branching shared by verify and review. */
  function handleRevisionOutcome(
    output: import('./types.js').PhaseOutput,
    source: 'verifier' | 'reviewer',
  ): PipelinePhase {
    if (output.revision && revisionCycles < maxRevisionCycles) {
      pendingRevision = output.revision;
      revisionCycles++;
      pendingRevision.cycle = revisionCycles;
      metrics.addRevisionCycle();
      notifier.send(`Revision cycle ${revisionCycles}: ${source} found fixable issues, re-implementing`);
      log.phase(source === 'verifier' ? 'verify' : 'review', 'revision-requested', {
        cycle: revisionCycles,
        source,
        failedCategories: output.revision.failedCategories.map((c) => c.category),
      });
      return 'implement';
    }
    if (output.revision && revisionCycles >= maxRevisionCycles) {
      metrics.setRevisionFixedIssues(false);
      notifier.send(`Revision budget exhausted (${maxRevisionCycles} cycles). Proceeding with warnings.`);
      log.phase(source === 'verifier' ? 'verify' : 'review', 'revision-budget-exhausted', { cycles: revisionCycles });
      return output.nextPhase;
    }
    // Clean pass — if after a revision, record success
    if (revisionCycles > 0) {
      metrics.setRevisionFixedIssues(true);
    }
    return output.nextPhase;
  }

  while (currentPhase !== 'complete' && currentPhase !== 'abort') {
    // Skip phases not in this profile
    if (!allowedPhases.has(currentPhase) && currentPhase !== 'retrospective') {
      const skipped = currentPhase;
      metrics.addSkippedPhase(skipped);
      currentPhase = nextPhaseInProfile(currentPhase, profile);
      log.phase(skipped, 'skipped-by-profile', { profile });
      continue;
    }

    log.phase(currentPhase, 'entering');
    const phaseAgent = PHASE_AGENT_MAP[currentPhase];
    if (phaseAgent) {
      metrics.startPhase(currentPhase, phaseAgent);
      notifier.phaseStart(currentPhase, phaseAgent);
      traceWriter.write({
        ts: new Date().toISOString(),
        phase: currentPhase,
        agent: phaseAgent,
        event: 'phase_start',
      });
    }
    const phaseStartMs = Date.now();

    switch (currentPhase) {
      case 'implement': {
        const output = await runImplementPhase(config, store, previousResults, pendingRevision ?? undefined);
        pendingRevision = null; // Clear after passing
        const elapsed = Date.now() - phaseStartMs;
        if (output.nextPhase === 'abort') {
          notifier.phaseEnd(currentPhase, 'implementer', elapsed, 'failed');
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
          notifier.phaseEnd(currentPhase, 'implementer', elapsed, 'completed');
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
        const elapsed = Date.now() - phaseStartMs;
        // Capture verifier rubric whenever available
        if (output.result.rubric?.role === 'verifier') {
          metrics.setVerifierRubric(output.result.rubric.categories);
        }
        if (output.nextPhase === 'abort') {
          notifier.phaseEnd(currentPhase, 'verifier', elapsed, 'failed');
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
          notifier.phaseEnd(currentPhase, 'verifier', elapsed, 'completed');
          metrics.endPhase('completed');
          currentPhase = handleRevisionOutcome(output, 'verifier');
        }
        break;
      }

      case 'review': {
        const output = await runReviewPhase(config, store, previousResults);
        const elapsed = Date.now() - phaseStartMs;
        // Capture review findings and rubric in metrics
        if (output.result.findings) {
          metrics.setReviewFindings(output.result.findings);
        }
        if (output.result.rubric?.role === 'reviewer') {
          metrics.setReviewerRubric(output.result.rubric.categories);
        }
        if (output.nextPhase === 'abort') {
          // Hard fails — existing abort handling
          notifier.phaseEnd(currentPhase, 'reviewer', elapsed, 'failed');
          metrics.endPhase('failed');
          const choice = await handleFailure(notifier, config, 'reviewer', output.result, [
            'Re-implement and re-review',
            'Override and continue',
            'Abort',
          ]);
          if (choice === 'Re-implement and re-review') {
            currentPhase = 'implement';
          } else if (choice === 'Override and continue') {
            metrics.addHumanOverride();
            currentPhase = 'close';
          } else {
            failedAgent = 'reviewer';
            outcome = 'failed';
            currentPhase = 'retrospective';
          }
        } else {
          notifier.phaseEnd(currentPhase, 'reviewer', elapsed, 'completed');
          metrics.endPhase('completed');
          currentPhase = handleRevisionOutcome(output, 'reviewer');
        }
        break;
      }

      case 'close': {
        const output = await runClosePhase(config, store, previousResults);
        const elapsed = Date.now() - phaseStartMs;
        if (output.nextPhase === 'abort') {
          notifier.phaseEnd(currentPhase, 'closer', elapsed, 'failed');
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
          notifier.phaseEnd(currentPhase, 'closer', elapsed, 'completed');
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
        traceWriter.write({
          ts: new Date().toISOString(),
          phase: currentPhase,
          agent: 'retrospective',
          event: 'phase_start',
        });
        const retroStart = Date.now();
        await runRetrospectivePhase(config, store, previousResults, outcome, failedAgent, metrics.snapshot());
        notifier.phaseEnd(currentPhase, 'retrospective', Date.now() - retroStart, 'completed');
        metrics.endPhase('completed');
        currentPhase = outcome === 'completed' ? 'complete' : 'abort';
        break;
      }
    }

    // Flush trace events after each phase
    if (phaseAgent) {
      traceWriter.write({
        ts: new Date().toISOString(),
        phase: currentPhase === 'complete' || currentPhase === 'abort' ? 'retrospective' : currentPhase,
        agent: phaseAgent,
        event: 'phase_end',
        outcome: outcome === 'failed' && failedAgent ? 'failed' : 'completed',
        durationMs: Date.now() - phaseStartMs,
      });
      await traceWriter.flush();
    }
  }

  // Finalize and write metrics
  const runMetrics = metrics.finalize(outcome, failedAgent);
  const priorRunId = await findPriorRunId(config.caseRoot, task.id);
  await writeRunMetrics(config.caseRoot, task.id, config.repoName, runMetrics, {
    priorRunId,
    parentTaskId: task.contractPath,
  });

  // Final trace flush
  await traceWriter.flush();

  log.info('pipeline finished', {
    outcome,
    failedAgent,
    runId: runMetrics.runId,
    totalDurationMs: runMetrics.totalDurationMs,
    traceFile: traceWriter.path,
  });

  if (outcome === 'failed') {
    notifier.send(`Pipeline failed at ${failedAgent ?? 'unknown'} phase.`);
  } else {
    notifier.send('Pipeline completed successfully.');
  }
}

/** Given a phase that was skipped, determine the next phase to try. */
function nextPhaseInProfile(skippedPhase: PipelinePhase, profile: PipelineProfile): PipelinePhase {
  const allowed = new Set(PROFILE_PHASES[profile]);
  return findNextAllowedPhase(skippedPhase, allowed) ?? 'complete';
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
