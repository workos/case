import type { AgentName, AgentResult, PipelineConfig, PipelinePhase, RevisionRequest, TaskStatus } from './types.js';
import { PROFILE_PHASES } from './types.js';
import { TaskStore } from './state/task-store.js';
import { determineEntryPhase, findNextAllowedPhase } from './state/transitions.js';
import { createNotifier, formatDuration, type Notifier } from './notify.js';
import { runImplementPhase } from './phases/implement.js';
import { runVerifyPhase } from './phases/verify.js';
import { runReviewPhase } from './phases/review.js';
import { runApprovePhase } from './phases/approve.js';
import { runClosePhase } from './phases/close.js';
import { runRetrospectivePhase, type MetricsSnapshot } from './phases/retrospective.js';
import { writeRunMetrics } from './metrics/writer.js';
import { getCurrentPromptVersions, findPriorRunId } from './versioning/prompt-tracker.js';
import { EventAppender } from './events/appender.js';
import { generatePlan } from './events/plan.js';
import { projectMetrics } from './events/projections.js';
import { PiRuntimeAdapter } from './agent/adapters/pi-adapter.js';
import { createLogger } from './util/logger.js';

const log = createLogger();

const PHASE_TO_STATUS: Partial<Record<PipelinePhase, TaskStatus>> = {
  implement: 'implementing',
  verify: 'verifying',
  review: 'reviewing',
  approve: 'approving',
  close: 'closing',
};

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
 * Uses EventAppender for lifecycle events, status tracking, and metrics.
 * Uses CaseAgentRuntime for agent spawning (defaults to PiRuntimeAdapter).
 */
export async function runPipeline(config: PipelineConfig): Promise<void> {
  const store = new TaskStore(config.taskJsonPath, config.caseRoot);
  const notifier = createNotifier(config.mode);
  const previousResults = new Map<AgentName, AgentResult>();

  config.onAgentHeartbeat = (elapsedMs) => {
    notifier.send(`  ... still running (${formatDuration(elapsedMs)})`);
  };

  const task = await store.read();
  const profile = task.profile ?? 'standard';
  const allowedPhases = new Set(PROFILE_PHASES[profile]);
  let currentPhase: PipelinePhase = determineEntryPhase(task, profile);
  let outcome: 'completed' | 'failed' = 'completed';
  let failedAgent: AgentName | undefined;
  let pendingRevision: RevisionRequest | null = task.pendingRevision ?? null;
  let revisionCycles = pendingRevision?.cycle ?? 0;
  const maxRevisionCycles = config.maxRevisionCycles ?? 2;

  // Approval-gate metrics tracked locally (not in event state yet)
  let approvalDecision: 'approved' | 'revised' | 'rejected' | 'skipped' | null = null;
  let approvalTimeMs: number | null = null;
  let humanOverrides = 0;
  let humanRevisionCycles = 0;

  const runId = crypto.randomUUID();
  config.runtime ??= new PiRuntimeAdapter();

  const appender = new EventAppender(config.caseRoot, task.id, runId, store);
  config.eventAppender = appender;

  const plan = generatePlan(task, config, runId);

  if (revisionCycles > 0) {
    // Crash recovery: restore prior state rather than emitting a new pipeline_start
    const resumeState: import('./events/types.js').PipelineState = {
      runId,
      taskId: task.id,
      profile,
      plan,
      status: task.status,
      phases: new Map(),
      currentPhase: null,
      revisionCycles,
      pendingRevision,
      markers: new Set(task.tested ? ['tested'] : []),
      outcome: 'running',
      startedAt: new Date().toISOString(),
      lastSequence: 0,
    };
    appender.restoreState(resumeState);
  } else {
    await appender.append({ event: 'pipeline_start', taskId: task.id, profile, plan });
  }

  const promptVersions = await getCurrentPromptVersions(config.caseRoot);

  log.info('pipeline started', { phase: currentPhase, mode: config.mode, task: task.id, runId });

  async function emitStatusChange(targetPhase: PipelinePhase): Promise<void> {
    const targetStatus = PHASE_TO_STATUS[targetPhase];
    if (!targetStatus) return;
    const currentStatus = appender.getState().status;
    if (currentStatus === targetStatus) return;
    await appender.append({ event: 'status_changed', from: currentStatus, to: targetStatus });
  }

  async function handleRevisionOutcome(
    output: import('./types.js').PhaseOutput,
    source: 'verifier' | 'reviewer',
  ): Promise<PipelinePhase> {
    if (output.revision && revisionCycles < maxRevisionCycles) {
      pendingRevision = output.revision;
      revisionCycles++;
      pendingRevision.cycle = revisionCycles;
      await store.setPendingRevision(pendingRevision);
      await appender.append({
        event: 'revision_requested',
        source,
        cycle: revisionCycles,
        failedCategories: output.revision.failedCategories,
      });
      notifier.send(`Revision cycle ${revisionCycles}: ${source} found fixable issues, re-implementing`);
      log.phase(source === 'verifier' ? 'verify' : 'review', 'revision-requested', {
        cycle: revisionCycles,
        source,
        failedCategories: output.revision.failedCategories.map((c) => c.category),
      });
      return 'implement';
    }
    if (output.revision && revisionCycles >= maxRevisionCycles) {
      await appender.append({ event: 'revision_budget_exhausted', cycles: revisionCycles });
      notifier.send(`Revision budget exhausted (${maxRevisionCycles} cycles). Proceeding with warnings.`);
      log.phase(source === 'verifier' ? 'verify' : 'review', 'revision-budget-exhausted', { cycles: revisionCycles });
      return output.nextPhase;
    }
    return output.nextPhase;
  }

  while (currentPhase !== 'complete' && currentPhase !== 'abort') {
    if (!allowedPhases.has(currentPhase) && currentPhase !== 'retrospective' && currentPhase !== 'approve') {
      const skipped = currentPhase;
      currentPhase = nextPhaseInProfile(currentPhase, allowedPhases);
      log.phase(skipped, 'skipped-by-profile', { profile });
      continue;
    }

    await emitStatusChange(currentPhase);

    log.phase(currentPhase, 'entering');
    const phaseAgent = PHASE_AGENT_MAP[currentPhase];
    const phaseStartMs = Date.now();

    if (phaseAgent) {
      await appender.append({ event: 'phase_start', phase: currentPhase, agent: phaseAgent });
      notifier.phaseStart(currentPhase, phaseAgent);
    }

    switch (currentPhase) {
      case 'implement': {
        const output = await runImplementPhase(config, store, previousResults, pendingRevision ?? undefined);
        const elapsed = Date.now() - phaseStartMs;
        if (output.nextPhase === 'abort') {
          notifier.phaseEnd(currentPhase, 'implementer', elapsed, 'failed');
          await appender.append({ event: 'phase_end', phase: 'implement', agent: 'implementer', outcome: 'failed', durationMs: elapsed, result: output.result });
          const choice = await handleFailure(notifier, config, 'implementer', output.result, [
            'Retry with guidance',
            'Abort',
          ]);
          if (choice === 'Retry with guidance') {
            currentPhase = 'implement';
          } else {
            failedAgent = 'implementer';
            outcome = 'failed';
            currentPhase = 'retrospective';
          }
        } else {
          pendingRevision = null;
          await store.setPendingRevision(null);
          notifier.phaseEnd(currentPhase, 'implementer', elapsed, 'completed');
          await appender.append({ event: 'phase_end', phase: 'implement', agent: 'implementer', outcome: 'completed', durationMs: elapsed, result: output.result });
          if (output.result.artifacts.testsPassed !== null) {
            // ciFirstPush tracked via metrics projection
          }
          currentPhase = output.nextPhase;
        }
        break;
      }

      case 'verify': {
        const output = await runVerifyPhase(config, store, previousResults);
        const elapsed = Date.now() - phaseStartMs;
        if (output.nextPhase === 'abort') {
          notifier.phaseEnd(currentPhase, 'verifier', elapsed, 'failed');
          await appender.append({ event: 'phase_end', phase: 'verify', agent: 'verifier', outcome: 'failed', durationMs: elapsed, result: output.result });
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
          await appender.append({ event: 'phase_end', phase: 'verify', agent: 'verifier', outcome: 'completed', durationMs: elapsed, result: output.result });
          currentPhase = await handleRevisionOutcome(output, 'verifier');
        }
        break;
      }

      case 'review': {
        const output = await runReviewPhase(config, store, previousResults);
        const elapsed = Date.now() - phaseStartMs;
        if (output.nextPhase === 'abort') {
          notifier.phaseEnd(currentPhase, 'reviewer', elapsed, 'failed');
          await appender.append({ event: 'phase_end', phase: 'review', agent: 'reviewer', outcome: 'failed', durationMs: elapsed, result: output.result });
          const choice = await handleFailure(notifier, config, 'reviewer', output.result, [
            'Re-implement and re-review',
            'Override and continue',
            'Abort',
          ]);
          if (choice === 'Re-implement and re-review') {
            currentPhase = 'implement';
          } else if (choice === 'Override and continue') {
            currentPhase = 'approve';
          } else {
            failedAgent = 'reviewer';
            outcome = 'failed';
            currentPhase = 'retrospective';
          }
        } else {
          notifier.phaseEnd(currentPhase, 'reviewer', elapsed, 'completed');
          await appender.append({ event: 'phase_end', phase: 'review', agent: 'reviewer', outcome: 'completed', durationMs: elapsed, result: output.result });
          currentPhase = await handleRevisionOutcome(output, 'reviewer');
          if (currentPhase === 'close') {
            currentPhase = 'approve';
          }
        }
        break;
      }

      case 'approve': {
        if (!config.approve || config.mode === 'unattended') {
          log.phase('approve', 'skipped', { approve: config.approve, mode: config.mode });
          approvalDecision = 'skipped';
          currentPhase = 'close';
          break;
        }

        const approveOutput = await runApprovePhase(config, store, previousResults, notifier);
        const approveElapsed = Date.now() - phaseStartMs;

        if (approveOutput.nextPhase === 'abort') {
          approvalDecision = 'rejected';
          approvalTimeMs = approveElapsed;
          notifier.phaseEnd('approve', 'human', approveElapsed, 'failed');
          outcome = 'failed';
          currentPhase = 'retrospective';
        } else if ((approveOutput.nextPhase === 'implement' || approveOutput.nextPhase === 'verify') && revisionCycles >= maxRevisionCycles) {
          approvalDecision = 'revised';
          approvalTimeMs = approveElapsed;
          await appender.append({ event: 'revision_budget_exhausted', cycles: revisionCycles });
          notifier.phaseEnd('approve', 'human', approveElapsed, 'completed');
          notifier.send(`Revision budget exhausted (${maxRevisionCycles} cycles). Proceeding to close.`);
          log.phase('approve', 'revision-budget-exhausted', { cycles: revisionCycles });
          currentPhase = 'close';
        } else if (approveOutput.nextPhase === 'implement' && approveOutput.revision) {
          approvalDecision = 'revised';
          approvalTimeMs = approveElapsed;
          humanRevisionCycles++;
          humanOverrides++;
          pendingRevision = approveOutput.revision;
          revisionCycles++;
          pendingRevision.cycle = revisionCycles;
          await store.setPendingRevision(pendingRevision);
          await appender.append({
            event: 'revision_requested',
            source: 'human',
            cycle: revisionCycles,
            failedCategories: approveOutput.revision.failedCategories,
          });
          notifier.phaseEnd('approve', 'human', approveElapsed, 'completed');
          notifier.send(`Human requested changes (cycle ${revisionCycles}): re-implementing`);
          currentPhase = 'implement';
        } else if (approveOutput.nextPhase === 'verify') {
          approvalDecision = 'revised';
          approvalTimeMs = approveElapsed;
          humanRevisionCycles++;
          humanOverrides++;
          revisionCycles++;
          await appender.append({
            event: 'revision_requested',
            source: 'human',
            cycle: revisionCycles,
            failedCategories: [],
          });
          notifier.phaseEnd('approve', 'human', approveElapsed, 'completed');
          notifier.send(`Manual edit complete (cycle ${revisionCycles}): re-verifying`);
          currentPhase = 'verify';
        } else {
          approvalDecision = 'approved';
          approvalTimeMs = approveElapsed;
          notifier.phaseEnd('approve', 'human', approveElapsed, 'completed');
          currentPhase = approveOutput.nextPhase;
        }
        break;
      }

      case 'close': {
        const output = await runClosePhase(config, store, previousResults);
        const elapsed = Date.now() - phaseStartMs;
        if (output.nextPhase === 'abort') {
          notifier.phaseEnd(currentPhase, 'closer', elapsed, 'failed');
          await appender.append({ event: 'phase_end', phase: 'close', agent: 'closer', outcome: 'failed', durationMs: elapsed, result: output.result });
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
          await appender.append({ event: 'phase_end', phase: 'close', agent: 'closer', outcome: 'completed', durationMs: elapsed, result: output.result });
          const prUrl = output.result.artifacts.prUrl;
          if (prUrl) {
            await appender.append({ event: 'status_changed', from: 'closing', to: 'pr-opened' });
            notifier.send(`PR created: ${prUrl}`);
          }
          currentPhase = output.nextPhase;
        }
        break;
      }

      case 'retrospective': {
        const retroStart = Date.now();
        const metricsSnapshot: MetricsSnapshot = {
          revisionCycles,
          humanOverrides,
          profile,
          evaluatorEffectiveness: projectMetrics(appender.getState()).evaluatorEffectiveness,
        };
        await runRetrospectivePhase(config, store, previousResults, outcome, failedAgent, metricsSnapshot);
        const retroElapsed = Date.now() - retroStart;
        notifier.phaseEnd(currentPhase, 'retrospective', retroElapsed, 'completed');
        await appender.append({ event: 'phase_end', phase: 'retrospective', agent: 'retrospective', outcome: 'completed', durationMs: retroElapsed });
        currentPhase = outcome === 'completed' ? 'complete' : 'abort';
        break;
      }
    }
  }

  const totalDurationMs = Date.now() - Date.parse(appender.getState().startedAt);
  await appender.append({ event: 'pipeline_end', outcome, failedAgent, durationMs: totalDurationMs });

  const runMetrics = projectMetrics(appender.getState());
  runMetrics.promptVersions = promptVersions;
  runMetrics.approvalDecision = approvalDecision;
  runMetrics.approvalTimeMs = approvalTimeMs;
  runMetrics.humanOverrides = humanOverrides;
  runMetrics.humanRevisionCycles = humanRevisionCycles;
  const priorRunId = await findPriorRunId(config.caseRoot, task.id);
  await writeRunMetrics(config.caseRoot, task.id, config.repoName, runMetrics, {
    priorRunId,
    parentTaskId: task.contractPath,
  });

  log.info('pipeline finished', {
    outcome,
    failedAgent,
    runId,
    totalDurationMs: runMetrics.totalDurationMs,
    eventLog: appender.path,
  });

  if (outcome === 'failed') {
    notifier.send(`Pipeline failed at ${failedAgent ?? 'unknown'} phase.`);
  } else {
    notifier.send('Pipeline completed successfully.');
  }
}

function nextPhaseInProfile(skippedPhase: PipelinePhase, allowed: Set<PipelinePhase>): PipelinePhase {
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
